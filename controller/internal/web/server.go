package web

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	"math"
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
	hub             *hub.Hub
	key             []byte
	firmwarePath    string
	firmwareName    string
	firmwareMu      sync.RWMutex
	calibrationMu   sync.Mutex
	calibrationPath string
	auth            *authStore
	leases          *leaseStore
}

type deviceView struct {
	hub.Device
	Lease *controlLease `json:"lease,omitempty"`
}

type motionCalibrationProfile struct {
	DeviceID                string  `json:"deviceId"`
	CenterDeg               float64 `json:"centerDeg"`
	Frequency               float64 `json:"frequency"`
	Amplitude               float64 `json:"amplitude"`
	LeftSign                int     `json:"leftSign"`
	LeftMaxOffset           float64 `json:"leftMaxOffset"`
	RightSign               int     `json:"rightSign"`
	RightMaxOffset          float64 `json:"rightMaxOffset"`
	TurnPercent             float64 `json:"turnPercent"`
	ServoMin                float64 `json:"servoMin"`
	ServoMax                float64 `json:"servoMax"`
	StraightCenter          float64 `json:"straightCenter"`
	ForwardFrequency        float64 `json:"forwardFrequency"`
	ForwardAmplitudePercent float64 `json:"forwardAmplitudePercent"`
	LeftCenterRatio         float64 `json:"leftCenterRatio"`
	LeftFrequency           float64 `json:"leftFrequency"`
	LeftAmplitudePercent    float64 `json:"leftAmplitudePercent"`
	RightCenterRatio        float64 `json:"rightCenterRatio"`
	RightFrequency          float64 `json:"rightFrequency"`
	RightAmplitudePercent   float64 `json:"rightAmplitudePercent"`
	TransitionMs            float64 `json:"transitionMs"`
	UpdatedAt               string  `json:"updatedAt"`
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

func motionCalibrationPath() string {
	if path := strings.TrimSpace(os.Getenv("FISH_MOTION_CALIBRATIONS")); path != "" {
		return path
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "fish-controller", "motion-calibrations.json")
}

func newHandler(h *hub.Hub, key []byte, apiAddress, streamAddress, firmwarePath string) http.Handler {
	s := &server{
		hub: h, key: append([]byte(nil), key...), firmwarePath: firmwarePath,
		calibrationPath: motionCalibrationPath(), auth: newAuthStore(authStorePath()),
		leases: newLeaseStore(60 * time.Second),
	}
	if firmwarePath != "" {
		s.firmwareName = filepath.Base(firmwarePath)
	}
	go s.leaseWatchdog()
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
	m.HandleFunc("/api/auth/me", s.authMe)
	m.HandleFunc("/api/auth/login", s.authLogin)
	m.HandleFunc("/api/auth/register", s.authRegister)
	m.HandleFunc("/api/auth/logout", s.authLogout)
	m.HandleFunc("/api/auth/users", s.authUsers)
	m.HandleFunc("/api/devices", s.devices)
	m.HandleFunc("/api/events", s.deviceEvents)
	m.HandleFunc("/api/leases", s.leasesAPI)
	m.HandleFunc("/api/command", s.command)
	m.HandleFunc("/api/command/realtime", s.realtimeCommand)
	m.HandleFunc("/api/emergency-stop", s.emergencyStop)
	m.HandleFunc("/api/motion-calibrations", s.motionCalibrations)
	m.HandleFunc("/api/rgb", s.rgb)
	m.HandleFunc("/api/ota", s.ota)
	m.HandleFunc("/api/firmware", s.firmwareAPI)
	m.HandleFunc("/api/firmware/current.bin", s.firmware)
	m.HandleFunc("/api/vision/device-command", s.visionDeviceCommand)
	m.Handle("/api/vision/", s.authenticatedVisionProxy(visionHandler))
	m.HandleFunc("/ws/device", s.deviceSocket)
	return m
}

func (s *server) leaseWatchdog() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		expired := s.leases.expire()
		if len(expired) == 0 {
			continue
		}
		for _, deviceID := range expired {
			_ = s.stopDevice(deviceID)
		}
		s.hub.Notify()
	}
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
		user, ok := s.requireUser(w, r)
		if !ok {
			return
		}
		if !canAdmin(user) {
			http.Error(w, "需要管理员权限", http.StatusForbidden)
			return
		}
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
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canAdmin(user) {
		http.Error(w, "需要管理员权限", http.StatusForbidden)
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
	message := map[string]any{
		"type":      "command",
		"requestId": requestID,
		"command":   "ota.start",
		"payload": map[string]any{
			"sha256": info["sha256"],
			"size":   info["size"],
		},
	}
	ack, sent, acknowledged := s.hub.SendAndWait(input.DeviceID, requestID, message, 30*time.Second)
	w.Header().Set("Content-Type", "application/json")
	if !sent {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": false, "acknowledged": false, "requestId": requestID, "message": "device offline"})
		return
	}
	if !acknowledged {
		w.WriteHeader(http.StatusGatewayTimeout)
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": true, "acknowledged": false, "requestId": requestID, "message": "OTA acknowledgement timeout"})
		return
	}
	if success, _ := ack["success"].(bool); !success {
		w.WriteHeader(http.StatusConflict)
	}
	ack["sent"] = true
	ack["acknowledged"] = true
	ack["sha256"] = info["sha256"]
	ack["size"] = info["size"]
	ack["name"] = info["name"]
	_ = json.NewEncoder(w).Encode(ack)
}

func (s *server) visionDeviceCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	var command struct {
		Operation string  `json:"operation"`
		DeviceID  string  `json:"deviceId"`
		SessionID string  `json:"sessionId"`
		Mode      string  `json:"mode"`
		Frequency float64 `json:"frequency"`
		Amplitude float64 `json:"amplitude"`
		Bias      float64 `json:"bias"`
	}
	if json.NewDecoder(r.Body).Decode(&command) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	if command.Operation != "start" && command.Operation != "motion" && command.Operation != "stop" && command.Operation != "calibrate-forward" {
		http.Error(w, "控制操作无效", http.StatusBadRequest)
		return
	}
	if command.Operation != "stop" && command.SessionID == "" {
		http.Error(w, "控制会话不能为空", http.StatusBadRequest)
		return
	}
	if s.authActive() && !s.isVisionInternalRequest(r) {
		user, ok := s.requireUser(w, r)
		if !ok {
			return
		}
		if !canControl(user) {
			http.Error(w, "需要操作员权限", http.StatusForbidden)
			return
		}
	}
	payload := map[string]any{"mode": "stop", "frequency": 0.0, "amplitude": 0.0, "bias": 0.0}
	if command.Operation == "motion" {
		payload["mode"] = command.Mode
		payload["frequency"] = command.Frequency
		payload["amplitude"] = command.Amplitude
		payload["bias"] = command.Bias
	} else if command.Operation == "calibrate-forward" {
		payload["mode"] = "forward"
		payload["frequency"] = 2.0
		payload["amplitude"] = 22.0
	}
	requestID := fmt.Sprintf("motion-%d", time.Now().UnixNano())
	deviceID := strings.TrimSpace(command.DeviceID)
	unique := deviceID != ""
	if !unique {
		deviceID, unique = s.hub.OnlyDeviceID()
	}
	w.Header().Set("Content-Type", "application/json")
	if !unique {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": false, "acknowledged": false, "success": false,
			"requestId": requestID, "message": "vision control requires a target device ID or exactly one online device",
		})
		return
	}
	if s.authActive() {
		if command.Operation == "start" || command.Operation == "calibrate-forward" || command.Operation == "motion" {
			if _, acquired := s.leases.acquireBot(deviceID, "vision-bot", "motion"); !acquired {
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sent": false, "acknowledged": false, "success": false,
					"requestId": requestID, "message": "device is controlled by another user",
				})
				return
			}
			s.hub.Notify()
			_ = s.leases.touchBot(deviceID, "vision-bot")
		}
		if command.Operation == "stop" {
			s.leases.releaseBot(deviceID, "vision-bot")
			s.hub.Notify()
		}
	}
	payload["deviceId"] = deviceID
	payload["controlSource"] = "vision-bot"
	message := map[string]any{
		"type": "command", "requestId": requestID, "deviceId": deviceID,
		"command": "motion.set", "payload": payload,
	}
	wait := 700 * time.Millisecond
	if command.Operation == "motion" {
		wait = 250 * time.Millisecond
	}
	ack, sent, acknowledged := s.hub.SendAndWait(deviceID, requestID, message, wait)
	if !sent {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": false, "acknowledged": false, "success": false,
			"requestId": requestID, "message": "device offline",
		})
		return
	}
	if !acknowledged {
		w.WriteHeader(http.StatusGatewayTimeout)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": true, "acknowledged": false, "success": false,
			"requestId": requestID, "message": "device acknowledgement timeout",
		})
		return
	}
	if success, _ := ack["success"].(bool); !success {
		w.WriteHeader(http.StatusConflict)
	}
	if success, _ := ack["success"].(bool); success {
		s.recordMotionState(deviceID, payload)
	}
	ack["sent"] = true
	ack["acknowledged"] = true
	_ = json.NewEncoder(w).Encode(ack)
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *server) devices(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireUser(w, r); !ok {
		return
	}
	out := s.deviceSnapshot()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (s *server) deviceSnapshot() []deviceView {
	leases := s.leases.snapshot()
	devices := s.hub.List()
	out := make([]deviceView, 0, len(devices))
	for _, device := range devices {
		view := deviceView{Device: device}
		if lease, ok := leases[device.ID]; ok {
			view.Lease = &lease
			view.ControlSource = lease.OwnerEmail
		} else {
			view.ControlSource = ""
		}
		out = append(out, view)
	}
	return out
}

func (s *server) deviceEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireUser(w, r); !ok {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET", http.StatusMethodNotAllowed)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "当前服务器不支持事件推送", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	updates, unsubscribe := s.hub.Subscribe()
	defer unsubscribe()

	writeSnapshot := func() error {
		data, err := json.Marshal(s.deviceSnapshot())
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: devices\ndata: %s\n\n", data); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	if err := writeSnapshot(); err != nil {
		return
	}

	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-updates:
			if err := writeSnapshot(); err != nil {
				return
			}
		case <-keepAlive.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *server) leasesAPI(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canControl(user) {
		http.Error(w, "需要操作员权限", http.StatusForbidden)
		return
	}
	var input struct {
		DeviceID string `json:"deviceId"`
		Mode     string `json:"mode"`
		Force    bool   `json:"force"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&input)
	}
	input.DeviceID = strings.TrimSpace(input.DeviceID)
	if input.DeviceID == "" {
		http.Error(w, "设备参数无效", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case http.MethodPost:
		lease, releasedIDs, acquired := s.leases.acquireExclusive(input.DeviceID, user, input.Mode, input.Force && canAdmin(user))
		if !acquired {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"acquired": false, "lease": lease, "message": "这条鱼正在被其他用户控制"})
			return
		}
		for _, deviceID := range releasedIDs {
			_ = s.stopDevice(deviceID)
		}
		s.hub.Notify()
		_ = json.NewEncoder(w).Encode(map[string]any{"acquired": true, "lease": lease})
	case http.MethodDelete:
		released := s.leases.release(input.DeviceID, user, input.Force && canAdmin(user))
		if !released {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"released": false, "message": "只能释放自己的控制权，管理员可强制释放"})
			return
		}
		_ = s.stopDevice(input.DeviceID)
		s.hub.Notify()
		_ = json.NewEncoder(w).Encode(map[string]any{"released": true})
	default:
		http.Error(w, "仅支持 POST / DELETE", http.StatusMethodNotAllowed)
	}
}

func (s *server) emergencyStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canAdmin(user) {
		http.Error(w, "需要管理员权限", http.StatusForbidden)
		return
	}
	devices := s.hub.List()
	type result struct {
		DeviceID     string `json:"deviceId"`
		Sent         bool   `json:"sent"`
		Acknowledged bool   `json:"acknowledged"`
		Success      bool   `json:"success"`
		Message      string `json:"message,omitempty"`
	}
	results := make([]result, 0, len(devices))
	for _, device := range devices {
		requestID := fmt.Sprintf("emergency-%d", time.Now().UnixNano())
		message := map[string]any{"type": "command", "requestId": requestID, "command": "emergency.stop", "payload": map[string]any{"operator": user.Email}}
		ack, sent, acknowledged := s.hub.SendAndWait(device.ID, requestID, message, 1200*time.Millisecond)
		item := result{DeviceID: device.ID, Sent: sent, Acknowledged: acknowledged}
		if acknowledged {
			item.Success, _ = ack["success"].(bool)
			item.Message, _ = ack["message"].(string)
		}
		results = append(results, item)
		_ = s.leases.release(device.ID, user, true)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"results": results})
}

func validMotionCalibration(p motionCalibrationProfile) bool {
	if p.DeviceID == "" {
		return false
	}
	if p.ServoMax != 0 || p.StraightCenter != 0 || p.ForwardFrequency != 0 {
		return p.ServoMin >= 0 && p.ServoMin < p.ServoMax && p.ServoMax <= 180 &&
			p.StraightCenter >= p.ServoMin && p.StraightCenter <= p.ServoMax &&
			p.ForwardFrequency >= 0.3 && p.ForwardFrequency <= 5 &&
			p.ForwardAmplitudePercent >= 0 && p.ForwardAmplitudePercent <= 1 &&
			p.LeftCenterRatio >= 0 && p.LeftCenterRatio <= 1 &&
			p.LeftFrequency >= 0.3 && p.LeftFrequency <= 5 &&
			p.LeftAmplitudePercent >= 0 && p.LeftAmplitudePercent <= 1 &&
			p.RightCenterRatio >= 0 && p.RightCenterRatio <= 1 &&
			p.RightFrequency >= 0.3 && p.RightFrequency <= 5 &&
			p.RightAmplitudePercent >= 0 && p.RightAmplitudePercent <= 1 &&
			p.TransitionMs >= 100 && p.TransitionMs <= 1500
	}
	return p.CenterDeg >= 45 && p.CenterDeg <= 135 &&
		p.Frequency >= 0.3 && p.Frequency <= 5 && p.Amplitude >= 0 && p.Amplitude <= 50 &&
		(p.LeftSign == -1 || p.LeftSign == 1) && (p.RightSign == -1 || p.RightSign == 1) &&
		p.LeftMaxOffset >= 0 && p.LeftMaxOffset <= 45 && p.RightMaxOffset >= 0 && p.RightMaxOffset <= 45 &&
		p.TurnPercent >= 0 && p.TurnPercent <= 100
}

func (s *server) readMotionCalibrations() map[string]motionCalibrationProfile {
	profiles := map[string]motionCalibrationProfile{}
	data, err := os.ReadFile(s.calibrationPath)
	if err == nil {
		_ = json.Unmarshal(data, &profiles)
	}
	return profiles
}

func clampMotionValue(value, min, max, fallback float64) float64 {
	if value < min || value > max {
		return fallback
	}
	return value
}

func (s *server) stopDevice(deviceID string) bool {
	requestID := fmt.Sprintf("lease-stop-%d", time.Now().UnixNano())
	message := map[string]any{
		"type": "command", "requestId": requestID,
		"command": "motion.set",
		"payload": map[string]any{
			"deviceId": deviceID, "controlSource": "lease",
			"mode": "stop", "frequency": 0.3, "amplitude": 0.0,
		},
	}
	_, sent, _ := s.hub.SendAndWait(deviceID, requestID, message, 700*time.Millisecond)
	if sent {
		s.recordMotionState(deviceID, message["payload"].(map[string]any))
	}
	return sent
}

func motionModeNumber(mode string) float64 {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "idle":
		return 1
	case "forward":
		return 2
	case "left":
		return 3
	case "right":
		return 4
	default:
		return 0
	}
}

func (s *server) recordMotionState(deviceID string, payload map[string]any) {
	mode, _ := payload["mode"].(string)
	source, _ := payload["controlSource"].(string)
	if strings.EqualFold(mode, "stop") {
		source = ""
	}
	values := map[string]any{
		"mode":          motionModeNumber(mode),
		"frequency":     payload["frequency"],
		"amplitude":     payload["amplitude"],
		"controlSource": source,
	}
	if bias, ok := payload["bias"]; ok {
		values["bias"] = bias
	} else {
		values["bias"] = 0.0
	}
	s.hub.Update(deviceID, values)
}

func profileServoRange(profile motionCalibrationProfile) (float64, float64, float64) {
	minimum := clampMotionValue(profile.ServoMin, 0, 179, 0)
	maximum := clampMotionValue(profile.ServoMax, minimum+1, 180, 180)
	center := clampMotionValue(profile.StraightCenter, minimum, maximum, 90)
	return minimum, maximum, center
}

func centerSwingForMode(profile motionCalibrationProfile, mode string) (float64, float64, bool) {
	if profile.ServoMax != 0 || profile.StraightCenter != 0 || profile.ForwardFrequency != 0 {
		minimum, maximum, center := profileServoRange(profile)
		balancedTurnOffset := (math.Min(center-minimum, maximum-center) / 2)
		var turnCenter float64
		if mode == "forward" || mode == "idle" || mode == "stop" {
			turnCenter = center
		} else if mode == "left" {
			turnCenter = center - balancedTurnOffset
		} else if mode == "right" {
			turnCenter = center + balancedTurnOffset
		} else {
			return 0, 0, false
		}
		swing := turnCenter - minimum
		if maximum-turnCenter < swing {
			swing = maximum - turnCenter
		}
		if swing < 0 {
			swing = 0
		}
		if mode == "forward" {
			swing /= 2
		}
		return turnCenter, swing, true
	}

	center := clampMotionValue(profile.CenterDeg, 45, 135, 90)
	if mode == "left" && (profile.LeftSign == -1 || profile.LeftSign == 1) {
		offset := clampMotionValue(profile.LeftMaxOffset, 0, 45, 15) * clampMotionValue(profile.TurnPercent, 0, 100, 60) / 100
		turnCenter := center + float64(profile.LeftSign)*offset
		return turnCenter, 50 - offset, true
	}
	if mode == "right" && (profile.RightSign == -1 || profile.RightSign == 1) {
		offset := clampMotionValue(profile.RightMaxOffset, 0, 45, 15) * clampMotionValue(profile.TurnPercent, 0, 100, 60) / 100
		turnCenter := center + float64(profile.RightSign)*offset
		return turnCenter, 50 - offset, true
	}
	return 0, 0, false
}

func defaultMotionProfile() motionCalibrationProfile {
	return motionCalibrationProfile{
		ServoMin:                0,
		ServoMax:                180,
		StraightCenter:          90,
		ForwardFrequency:        2.5,
		ForwardAmplitudePercent: 0.4,
		LeftCenterRatio:         0.5,
		LeftFrequency:           2.3,
		LeftAmplitudePercent:    0.4,
		RightCenterRatio:        0.5,
		RightFrequency:          2.3,
		RightAmplitudePercent:   0.4,
		TransitionMs:            600,
	}
}

func (s *server) motionProfileForDevice(deviceID string) motionCalibrationProfile {
	profile := defaultMotionProfile()
	s.calibrationMu.Lock()
	profiles := s.readMotionCalibrations()
	saved, ok := profiles[deviceID]
	s.calibrationMu.Unlock()
	if ok && validMotionCalibration(saved) {
		profile = saved
	}
	return profile
}

func (s *server) applyMotionGeometry(deviceID, mode string, frequency, amplitude, bias float64, hasBias bool, amplitudePercent *float64) (float64, float64, float64, bool) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode != "forward" && mode != "left" && mode != "right" && mode != "idle" && mode != "stop" {
		return frequency, amplitude, bias, hasBias
	}
	profile := s.motionProfileForDevice(deviceID)
	center, maxSwing, ok := centerSwingForMode(profile, mode)
	if !ok {
		return frequency, amplitude, bias, hasBias
	}

	if mode == "stop" {
		amplitude = 0
	} else if amplitudePercent != nil {
		percent := clampMotionValue(*amplitudePercent, 0, 100, 40)
		amplitude = maxSwing * percent / 100.0
	} else if amplitude > maxSwing {
		amplitude = maxSwing
	}
	if !hasBias {
		bias = center - 90
		if bias < -90 {
			bias = -90
		}
		if bias > 90 {
			bias = 90
		}
		hasBias = true
	}
	return frequency, amplitude, bias, hasBias
}

func (s *server) motionCalibrations(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	s.calibrationMu.Lock()
	defer s.calibrationMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	profiles := s.readMotionCalibrations()
	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(profiles)
		return
	}
	if !canControl(user) {
		http.Error(w, "需要操作员权限", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "仅支持 GET / PUT", http.StatusMethodNotAllowed)
		return
	}
	var profile motionCalibrationProfile
	if json.NewDecoder(r.Body).Decode(&profile) != nil || !validMotionCalibration(profile) {
		http.Error(w, "标定参数无效", http.StatusBadRequest)
		return
	}
	profile.UpdatedAt = time.Now().Format(time.RFC3339)
	profiles[profile.DeviceID] = profile
	data, _ := json.MarshalIndent(profiles, "", "  ")
	if err := os.MkdirAll(filepath.Dir(s.calibrationPath), 0o755); err != nil {
		http.Error(w, "无法创建标定目录", http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(s.calibrationPath, data, 0o644); err != nil {
		http.Error(w, "无法保存标定参数", http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(profile)
}

func (s *server) command(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canControl(user) {
		http.Error(w, "需要操作员权限", http.StatusForbidden)
		return
	}
	var x struct {
		DeviceID, Mode         string
		Frequency, Amplitude   float64
		AmplitudePercent, Bias *float64
	}
	if json.NewDecoder(r.Body).Decode(&x) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	if x.DeviceID == "" || x.Frequency < 0.3 || x.Frequency > 5 || x.Amplitude < 0 || x.Amplitude > 90 || (x.AmplitudePercent != nil && (*x.AmplitudePercent < 0 || *x.AmplitudePercent > 100)) || (x.Bias != nil && (*x.Bias < -90 || *x.Bias > 90)) {
		http.Error(w, "参数无效", http.StatusBadRequest)
		return
	}
	mode := strings.ToLower(x.Mode)
	if mode != "stop" && s.authActive() && !s.leases.touch(x.DeviceID, user) && !canAdmin(user) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": false, "acknowledged": false, "success": false, "message": "请先获取这条鱼的控制权"})
		return
	}
	var bias float64
	hasBias := x.Bias != nil
	if hasBias {
		bias = *x.Bias
	}
	x.Frequency, x.Amplitude, bias, hasBias = s.applyMotionGeometry(x.DeviceID, mode, x.Frequency, x.Amplitude, bias, hasBias, x.AmplitudePercent)
	requestID := fmt.Sprintf("%d", time.Now().UnixNano())
	payload := map[string]any{
		"deviceId": x.DeviceID, "controlSource": user.Email,
		"mode": mode, "frequency": x.Frequency,
		"amplitude": x.Amplitude,
	}
	if hasBias {
		payload["bias"] = bias
	}
	msg := map[string]any{
		"type": "command", "requestId": requestID, "deviceId": x.DeviceID, "command": "motion.set",
		"payload": payload,
	}
	w.Header().Set("Content-Type", "application/json")
	ack, sent, acknowledged := s.hub.SendAndWait(x.DeviceID, requestID, msg, 2500*time.Millisecond)
	if !sent {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": false, "acknowledged": false, "requestId": requestID, "message": "device offline"})
		return
	}
	if !acknowledged {
		w.WriteHeader(http.StatusGatewayTimeout)
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": true, "acknowledged": false, "requestId": requestID, "message": "device acknowledgement timeout"})
		return
	}
	if success, _ := ack["success"].(bool); !success {
		w.WriteHeader(http.StatusConflict)
	}
	if success, _ := ack["success"].(bool); success {
		s.recordMotionState(x.DeviceID, payload)
	}
	ack["sent"] = true
	ack["acknowledged"] = true
	_ = json.NewEncoder(w).Encode(ack)
}

// realtimeCommand is used by keyboard control. It acknowledges queueing only;
// the regular command endpoint remains responsible for device-level ACKs.
func (s *server) realtimeCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canControl(user) {
		http.Error(w, "需要操作员权限", http.StatusForbidden)
		return
	}
	var x struct {
		DeviceID, Mode         string
		Frequency, Amplitude   float64
		AmplitudePercent, Bias *float64
	}
	if json.NewDecoder(r.Body).Decode(&x) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	if x.DeviceID == "" || x.Frequency < 0.3 || x.Frequency > 5 ||
		x.Amplitude < 0 || x.Amplitude > 90 ||
		(x.AmplitudePercent != nil && (*x.AmplitudePercent < 0 || *x.AmplitudePercent > 100)) ||
		(x.Bias != nil && (*x.Bias < -90 || *x.Bias > 90)) {
		http.Error(w, "参数无效", http.StatusBadRequest)
		return
	}
	mode := strings.ToLower(x.Mode)
	if mode != "stop" && s.authActive() &&
		!s.leases.touch(x.DeviceID, user) && !canAdmin(user) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": false, "queued": false, "success": false,
			"message": "请先获取这条鱼的控制权",
		})
		return
	}
	var bias float64
	hasBias := x.Bias != nil
	if hasBias {
		bias = *x.Bias
	}
	x.Frequency, x.Amplitude, bias, hasBias =
		s.applyMotionGeometry(x.DeviceID, mode, x.Frequency, x.Amplitude, bias, hasBias, x.AmplitudePercent)
	requestID := fmt.Sprintf("realtime-%d", time.Now().UnixNano())
	payload := map[string]any{
		"deviceId": x.DeviceID, "controlSource": user.Email,
		"mode": mode, "frequency": x.Frequency,
		"amplitude": x.Amplitude,
	}
	if hasBias {
		payload["bias"] = bias
	}
	message := map[string]any{
		"type": "command", "requestId": requestID, "deviceId": x.DeviceID,
		"command": "motion.set", "payload": payload,
	}
	if !s.hub.SendLatest(x.DeviceID, message) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": false, "queued": false, "success": false,
			"requestId": requestID, "message": "device offline",
		})
		return
	}
	s.recordMotionState(x.DeviceID, payload)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"sent": true, "queued": true, "acknowledged": false,
		"success": true, "requestId": requestID, "applied": payload,
	})
}

func (s *server) authenticatedVisionProxy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.authActive() {
			if _, ok := s.requireUser(w, r); !ok {
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) isVisionInternalRequest(r *http.Request) bool {
	configured := strings.TrimSpace(os.Getenv("FISH_VISION_INTERNAL_TOKEN"))
	provided := strings.TrimSpace(r.Header.Get("X-Fish-Vision-Internal"))
	return configured != "" &&
		subtle.ConstantTimeCompare([]byte(configured), []byte(provided)) == 1
}

func (s *server) rgb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canAdmin(user) {
		http.Error(w, "需要管理员权限", http.StatusForbidden)
		return
	}
	var input struct {
		DeviceID, Mode, Order        string
		Red, Green, Blue, Brightness int
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.DeviceID == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	input.Mode = strings.ToUpper(input.Mode)
	input.Order = strings.ToUpper(input.Order)
	if input.Order == "" {
		input.Order = "GRB"
	}
	validOrder := false
	for _, order := range []string{"RGB", "RBG", "GRB", "GBR", "BRG", "BGR"} {
		if input.Order == order {
			validOrder = true
		}
	}
	if !validOrder {
		http.Error(w, "invalid RGB order", http.StatusBadRequest)
		return
	}
	if input.Mode != "AUTO" && (input.Mode != "SOLID" || input.Red < 0 || input.Red > 255 || input.Green < 0 || input.Green > 255 || input.Blue < 0 || input.Blue > 255 || input.Brightness < 1 || input.Brightness > 255) {
		http.Error(w, "invalid RGB parameters", http.StatusBadRequest)
		return
	}
	requestID := fmt.Sprintf("rgb-%d", time.Now().UnixNano())
	message := map[string]any{"type": "command", "requestId": requestID, "command": "rgb.set", "payload": map[string]any{"mode": input.Mode, "order": input.Order, "red": input.Red, "green": input.Green, "blue": input.Blue, "brightness": input.Brightness}}
	ack, sent, acknowledged := s.hub.SendAndWait(input.DeviceID, requestID, message, 2500*time.Millisecond)
	w.Header().Set("Content-Type", "application/json")
	if !sent {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": false, "acknowledged": false, "requestId": requestID, "message": "device offline"})
		return
	}
	if !acknowledged {
		w.WriteHeader(http.StatusGatewayTimeout)
		_ = json.NewEncoder(w).Encode(map[string]any{"sent": true, "acknowledged": false, "requestId": requestID, "message": "device acknowledgement timeout"})
		return
	}
	if success, _ := ack["success"].(bool); !success {
		w.WriteHeader(http.StatusConflict)
	}
	ack["sent"] = true
	ack["acknowledged"] = true
	_ = json.NewEncoder(w).Encode(ack)
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
	d := hub.Device{ID: id, Name: text(reg["name"]), IP: text(reg["ip"]), FirmwareVersion: text(reg["firmwareVersion"]), Capabilities: texts(reg["capabilities"])}
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
		if messageType, _ := msg["type"].(string); messageType == "command.result" {
			s.hub.ResolveCommandResult(msg)
		}
		s.hub.Update(id, msg)
	}
}

func text(v any) string { s, _ := v.(string); return s }
func texts(v any) []string {
	values, _ := v.([]any)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if item, ok := value.(string); ok {
			result = append(result, item)
		}
	}
	return result
}

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
