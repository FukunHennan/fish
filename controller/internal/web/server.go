package web

import (
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fish-controller/internal/hub"
	"fish-controller/internal/identity"
	"fish-controller/internal/visionproxy"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed dist
var frontendFiles embed.FS

const maxFirmwareSize int64 = 8 << 20

type server struct {
	hub          *hub.Hub
	key          []byte
	firmwarePath string
	firmwareName string
	firmwareMu   sync.RWMutex
}

type deviceConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *deviceConn) WriteJSON(value any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(value)
}
func (c *deviceConn) Close() error { return c.conn.Close() }

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func NewHandler(h *hub.Hub, key []byte) http.Handler {
	return newHandler(h, key, "http://127.0.0.1:8091", "http://127.0.0.1:8090", defaultFirmwarePath())
}

func NewHandlerWithVision(h *hub.Hub, key []byte, apiAddress, streamAddress string) http.Handler {
	return newHandler(h, key, apiAddress, streamAddress, defaultFirmwarePath())
}

func NewHandlerWithFirmware(h *hub.Hub, key []byte, firmwarePath string) http.Handler {
	return newHandler(h, key, "http://127.0.0.1:8091", "http://127.0.0.1:8090", firmwarePath)
}

func defaultFirmwarePath() string {
	if path := os.Getenv("FISH_FIRMWARE_BIN"); path != "" {
		return path
	}
	for _, path := range []string{
		filepath.Join("..", "firmware", ".pio", "build", "seeed_xiao_esp32c3", "firmware.bin"),
		filepath.Join("firmware", ".pio", "build", "seeed_xiao_esp32c3", "firmware.bin"),
	} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func uploadedFirmwarePath() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "fish-controller", "firmware", "current.bin")
}

func newHandler(h *hub.Hub, key []byte, apiAddress, streamAddress, firmwarePath string) http.Handler {
	s := &server{hub: h, key: append([]byte(nil), key...), firmwarePath: firmwarePath}
	if firmwarePath != "" {
		s.firmwareName = filepath.Base(firmwarePath)
	}
	m := http.NewServeMux()
	visionHandler, err := visionproxy.New(apiAddress, streamAddress)
	if err != nil {
		panic(err)
	}
	staticFiles, err := fs.Sub(frontendFiles, "dist")
	if err != nil {
		panic(err)
	}
	m.Handle("/assets/", http.FileServer(http.FS(staticFiles)))
	m.HandleFunc("/", s.dashboard)
	m.HandleFunc("/healthz", s.health)
	m.HandleFunc("/api/devices", s.devices)
	m.HandleFunc("/api/command", s.command)
	m.HandleFunc("/api/ota", s.ota)
	m.HandleFunc("/api/firmware", s.firmwareAPI)
	m.HandleFunc("/api/firmware/current.bin", s.firmware)
	m.HandleFunc("/api/vision/device-command", s.visionDeviceCommand)
	m.Handle("/api/vision/", visionHandler)
	m.HandleFunc("/ws/device", s.deviceSocket)
	return m
}

func (s *server) firmwareSnapshot() (string, string) {
	s.firmwareMu.RLock()
	defer s.firmwareMu.RUnlock()
	return s.firmwarePath, s.firmwareName
}

func readFirmware(path string) ([]byte, error) {
	if path == "" {
		return nil, os.ErrNotExist
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < 4 || data[0] != 0xE9 {
		return nil, fmt.Errorf("invalid ESP32 image")
	}
	return data, nil
}

func firmwareInfo(path, name string) (map[string]any, error) {
	data, err := readFirmware(path)
	if err != nil {
		return nil, err
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	return map[string]any{
		"available": true,
		"name":      name,
		"size":      len(data),
		"sha256":    hash,
	}, nil
}

func (s *server) firmwareAPI(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		path, name := s.firmwareSnapshot()
		w.Header().Set("Content-Type", "application/json")
		info, err := firmwareInfo(path, name)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"available": false})
			return
		}
		_ = json.NewEncoder(w).Encode(info)
	case http.MethodPost:
		s.uploadFirmware(w, r)
	default:
		http.Error(w, "仅支持 GET 或 POST", http.StatusMethodNotAllowed)
	}
}

func (s *server) uploadFirmware(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFirmwareSize+(1<<20))
	if err := r.ParseMultipartForm(maxFirmwareSize); err != nil {
		http.Error(w, "固件文件过大或上传格式错误", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("firmware")
	if err != nil {
		http.Error(w, "请选择 firmware.bin", http.StatusBadRequest)
		return
	}
	defer file.Close()
	if strings.ToLower(filepath.Ext(header.Filename)) != ".bin" {
		http.Error(w, "只允许上传 .bin 固件", http.StatusBadRequest)
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, maxFirmwareSize+1))
	if err != nil || int64(len(data)) > maxFirmwareSize {
		http.Error(w, "固件读取失败或文件过大", http.StatusBadRequest)
		return
	}
	if len(data) < 4 || data[0] != 0xE9 {
		http.Error(w, "不是有效的 ESP32 firmware.bin", http.StatusBadRequest)
		return
	}

	destination := uploadedFirmwarePath()
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		http.Error(w, "无法创建固件目录", http.StatusInternalServerError)
		return
	}
	temporary := destination + ".upload"
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		http.Error(w, "无法保存固件", http.StatusInternalServerError)
		return
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(temporary)
		http.Error(w, "无法替换当前固件", http.StatusInternalServerError)
		return
	}

	s.firmwareMu.Lock()
	s.firmwarePath = destination
	s.firmwareName = filepath.Base(header.Filename)
	s.firmwareMu.Unlock()

	info, _ := firmwareInfo(destination, filepath.Base(header.Filename))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(info)
}

func (s *server) firmware(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET", http.StatusMethodNotAllowed)
		return
	}
	path, _ := s.firmwareSnapshot()
	if _, err := readFirmware(path); err != nil {
		http.Error(w, "固件尚未上传或构建", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}

func (s *server) ota(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		DeviceID string `json:"deviceId"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.DeviceID == "" {
		http.Error(w, "设备参数无效", http.StatusBadRequest)
		return
	}
	path, name := s.firmwareSnapshot()
	info, err := firmwareInfo(path, name)
	if err != nil {
		http.Error(w, "固件不可用或格式错误", http.StatusConflict)
		return
	}
	requestID := fmt.Sprintf("ota-%d", time.Now().UnixNano())
	sent := s.hub.Send(input.DeviceID, map[string]any{
		"type":      "command",
		"requestId": requestID,
		"command":   "ota.start",
		"payload": map[string]any{
			"sha256": info["sha256"],
			"size":   info["size"],
		},
	})
	w.Header().Set("Content-Type", "application/json")
	if !sent {
		w.WriteHeader(http.StatusConflict)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"sent":      sent,
		"requestId": requestID,
		"sha256":    info["sha256"],
		"size":      info["size"],
		"name":      info["name"],
	})
}

func (s *server) visionDeviceCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	var command struct {
		Operation        string  `json:"operation"`
		SessionID        string  `json:"sessionId"`
		Sequence         uint32  `json:"sequence"`
		CrossTrackError  float64 `json:"crossTrackError"`
		HeadingErrorDeg  float64 `json:"headingErrorDeg"`
		DistanceToTarget float64 `json:"distanceToTarget"`
		Speed            float64 `json:"speed"`
		Curvature        float64 `json:"curvature"`
		Brake            bool    `json:"brake"`
	}
	if json.NewDecoder(r.Body).Decode(&command) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	if command.Operation != "start" && command.Operation != "update" && command.Operation != "stop" {
		http.Error(w, "视觉操作无效", http.StatusBadRequest)
		return
	}
	if command.Operation != "stop" && command.SessionID == "" {
		http.Error(w, "视觉会话不能为空", http.StatusBadRequest)
		return
	}
	payload := map[string]any{"sessionId": command.SessionID}
	if command.Operation == "update" {
		payload["sequence"] = command.Sequence
		payload["crossTrackError"] = command.CrossTrackError
		payload["headingErrorDeg"] = command.HeadingErrorDeg
		payload["distanceToTarget"] = command.DistanceToTarget
		payload["speed"] = command.Speed
		payload["curvature"] = command.Curvature
		payload["brake"] = command.Brake
	}
	requestID := fmt.Sprintf("vision-%d", time.Now().UnixNano())
	sent := s.hub.SendOnly(map[string]any{
		"type": "command", "requestId": requestID,
		"command": "vision." + command.Operation, "payload": payload,
	})
	w.Header().Set("Content-Type", "application/json")
	if !sent {
		w.WriteHeader(http.StatusConflict)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"sent": sent, "requestId": requestID})
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *server) devices(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.hub.List())
}

func (s *server) command(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	var x struct {
		DeviceID, Mode       string
		Frequency, Amplitude float64
		Bias                 float64
	}
	if json.NewDecoder(r.Body).Decode(&x) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	if x.DeviceID == "" || x.Frequency < 0.3 || x.Frequency > 5 || x.Amplitude < 0 || x.Amplitude > 50 || x.Bias < -45 || x.Bias > 45 {
		http.Error(w, "参数无效", http.StatusBadRequest)
		return
	}
	requestID := fmt.Sprintf("%d", time.Now().UnixNano())
	msg := map[string]any{
		"type": "command", "requestId": requestID, "command": "motion.set",
		"payload": map[string]any{
			"mode": strings.ToLower(x.Mode), "frequency": x.Frequency,
			"amplitude": x.Amplitude, "bias": x.Bias,
		},
	}
	ok := s.hub.Send(x.DeviceID, msg)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"sent": ok, "requestId": requestID})
}

func (s *server) deviceSocket(w http.ResponseWriter, r *http.Request) {
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &deviceConn{conn: rawConn}
	defer c.Close()
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return
	}
	nonce := hex.EncodeToString(nonceBytes)
	if c.WriteJSON(map[string]any{"type": "auth.challenge", "protocolVersion": 1, "nonce": nonce}) != nil {
		return
	}
	var reg map[string]any
	if rawConn.ReadJSON(&reg) != nil {
		return
	}
	id, _ := reg["deviceId"].(string)
	proof, _ := reg["proof"].(string)
	version, _ := reg["protocolVersion"].(float64)
	if id == "" || version != 1 || !identity.Verify(s.key, "fish-websocket-v1", nonce, id, proof) {
		_ = c.WriteJSON(map[string]any{"type": "register.result", "success": false})
		return
	}
	d := hub.Device{ID: id, Name: text(reg["name"]), IP: text(reg["ip"]), FirmwareVersion: text(reg["firmwareVersion"])}
	s.hub.Register(d, c)
	log.Printf("device registered: %s (%s), source %s", id, d.IP, r.RemoteAddr)
	defer s.hub.Remove(id, c)
	_ = c.WriteJSON(map[string]any{"type": "register.result", "success": true})
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := c.WriteJSON(map[string]any{"type": "heartbeat"}); err != nil {
					log.Printf("device heartbeat failed: %s: %v", id, err)
					return
				}
			case <-done:
				return
			}
		}
	}()
	defer close(done)
	for {
		var msg map[string]any
		if err := rawConn.ReadJSON(&msg); err != nil {
			log.Printf("device disconnected: %s: %v", id, err)
			return
		}
		s.hub.Update(id, msg)
	}
}

func text(v any) string { s, _ := v.(string); return s }

func (s *server) dashboard(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	index, err := frontendFiles.ReadFile("dist/index.html")
	if err != nil {
		http.Error(w, "网页资源不可用", http.StatusInternalServerError)
		return
	}
	_, _ = w.Write(index)
}
