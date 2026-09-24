package web

import (
	"bufio"
	"bytes"
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
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed dist
var frontendFiles embed.FS

const maxFirmwareSize int64 = 8 << 20

// Wi-Fi and ESP32 scheduling can briefly delay a heartbeat. A longer socket
// deadline avoids turning short LAN jitter into a full reconnect.
const deviceHeartbeatTimeout = 10 * time.Second
const visionMotionTimeout = 3 * time.Second

// commandAckTimeout expands the ACK window using the measured device
// WebSocket RTT. This matters when an ESP32 is connected through a public
// tunnel: a fixed window can report a healthy device as offline.
func (s *server) commandAckTimeout(deviceID string, base, maximum time.Duration) time.Duration {
	wait := base
	if rtt, ok := s.hub.HeartbeatRTT(deviceID); ok {
		candidate := 500*time.Millisecond + 4*rtt
		if candidate > wait {
			wait = candidate
		}
	}
	if wait > maximum {
		return maximum
	}
	return wait
}

type server struct {
	hub              *hub.Hub
	key              []byte
	firmwarePath     string
	firmwareName     string
	firmwareMu       sync.RWMutex
	calibrationMu    sync.Mutex
	calibrationPath  string
	auth             *authStore
	leases           *leaseStore
	competition      *competitionStore
	visionAPIAddress string
	visionHTTPClient *http.Client
	logger           *slog.Logger
}

type deviceView struct {
	hub.Device
	Lease *controlLease `json:"lease,omitempty"`
}

func (s *server) event(message string, args ...any) {
	if s.logger != nil {
		s.logger.Info(message, args...)
	}
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
	// A blocked write must not hold a timeout STOP behind it indefinitely.
	if err := c.conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	return c.conn.WriteJSON(value)
}
func (c *deviceConn) WritePing(payload string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteControl(websocket.PingMessage, []byte(payload), time.Now().Add(time.Second))
}
func (c *deviceConn) Close() error { return c.conn.Close() }

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func NewHandler(h *hub.Hub, key []byte) http.Handler {
	return newHandler(h, key, "http://127.0.0.1:8091", "http://127.0.0.1:8090", defaultFirmwarePath(), nil)
}

func NewHandlerWithVision(h *hub.Hub, key []byte, apiAddress, streamAddress string) http.Handler {
	return newHandler(h, key, apiAddress, streamAddress, defaultFirmwarePath(), nil)
}

func NewHandlerWithFirmware(h *hub.Hub, key []byte, firmwarePath string) http.Handler {
	return newHandler(h, key, "http://127.0.0.1:8091", "http://127.0.0.1:8090", firmwarePath, nil)
}

// NewHandlerWithDiagnostics attaches the controller's structured diagnostic
// logger to device, lease, and control-channel lifecycle events. Tests and
// embedded callers can continue using NewHandler without a logger.
func NewHandlerWithDiagnostics(h *hub.Hub, key []byte, logger *slog.Logger) http.Handler {
	return newHandler(h, key, "http://127.0.0.1:8091", "http://127.0.0.1:8090", defaultFirmwarePath(), logger)
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

func newHandler(h *hub.Hub, key []byte, apiAddress, streamAddress, firmwarePath string, logger *slog.Logger) http.Handler {
	s := &server{
		hub: h, key: append([]byte(nil), key...), firmwarePath: firmwarePath,
		calibrationPath: motionCalibrationPath(), auth: newAuthStore(authStorePath()),
		leases:           newLeaseStore(60 * time.Second),
		competition:      newCompetitionStore(competitionPath()),
		visionAPIAddress: strings.TrimRight(apiAddress, "/"),
		visionHTTPClient: &http.Client{Timeout: 10 * time.Second},
		logger:           logger,
	}
	// With authentication disabled and no explicit state path, the controller is
	// running in local development mode. Seed the four known competitors as
	// already logged in, while keeping any existing saved match untouched.
	if strings.EqualFold(strings.TrimSpace(os.Getenv("FISH_DEVELOPMENT_MODE")), "true") &&
		!s.authActive() && strings.TrimSpace(os.Getenv("FISH_COMPETITION_STATE")) == "" {
		s.competition.ensureDevelopmentMatch()
	}
	if s.authActive() {
		if err := s.leases.loadReservations(authStorePath() + ".reservations.json"); err != nil {
			panic(fmt.Errorf("load fish reservations: %w", err))
		}
	}
	s.leases.onRelease = func(id string) { s.hub.StopAndReset(id) }
	if firmwarePath != "" {
		s.firmwareName = filepath.Base(firmwarePath)
	}
	go s.leaseWatchdog()
	go s.visionMotionWatchdog()
	m := http.NewServeMux()
	visionHandler, err := visionproxy.New(apiAddress, streamAddress)
	if err != nil {
		panic(err)
	}
	staticFiles, err := fs.Sub(frontendFiles, "dist")
	if err != nil {
		panic(err)
	}
	// Serve one public application. The competition shell is the canonical UI;
	// old root/console/index aliases redirect there instead of exposing a
	// second operator interface.
	// http.FileServer resolves index.html for directories and rejects paths
	// that escape the embedded FS.
	embedded := http.FileServer(http.FS(staticFiles))
	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// The competition shell, iframe pages, and adapter script are deployed
		// together. Do not let a public CDN/browser keep an older bundle after a
		// controller restart, otherwise the outer page and iframe can disagree
		// about their session state and appear to refresh repeatedly.
		if r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/competition") {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
			w.Header().Set("Pragma", "no-cache")
		}
		switch r.URL.Path {
		case "/", "/console.html", "/index.html":
			http.Redirect(w, r, "/competition.html", http.StatusTemporaryRedirect)
		default:
			embedded.ServeHTTP(w, r)
		}
	})
	m.HandleFunc("/api/status", s.status)
	m.HandleFunc("/healthz", s.health)
	m.HandleFunc("/api/auth/me", s.authMe)
	m.HandleFunc("/api/auth/login", s.authLogin)
	m.HandleFunc("/api/auth/register", s.authRegister)
	m.HandleFunc("/api/auth/logout", s.authLogout)
	m.HandleFunc("/api/auth/users", s.authUsers)
	m.HandleFunc("/api/devices", s.devices)
	m.HandleFunc("/api/events", s.deviceEvents)
	m.HandleFunc("/api/logs", s.logsAPI)
	m.HandleFunc("/api/leases", s.leasesAPI)
	m.HandleFunc("/api/command", s.command)
	m.HandleFunc("/api/command/realtime", s.realtimeCommand)
	m.HandleFunc("/api/emergency-stop", s.emergencyStop)
	m.HandleFunc("/api/motion-calibrations", s.motionCalibrations)
	m.HandleFunc("/api/competition/", s.competitionAPI)
	m.HandleFunc("/api/ota", s.ota)
	m.HandleFunc("/api/firmware", s.firmwareAPI)
	m.HandleFunc("/api/firmware/current.bin", s.firmware)
	m.HandleFunc("/api/vision/device-command", s.visionDeviceCommand)
	m.Handle("/api/vision/", s.authenticatedVisionProxy(visionHandler))
	m.HandleFunc("/ws/device", s.deviceSocket)
	m.HandleFunc("/ws/control", s.controlSocket)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("X-Fish-API-Version", "1")
			w.Header().Set("Cache-Control", "no-store")
		}
		m.ServeHTTP(w, r)
	})
}

// controlSocket carries the browser's high-rate motion frames over one
// persistent connection. It deliberately reuses realtimeCommand so auth,
// lease ownership, sequence ordering and device admission stay identical to
// the HTTP fallback path.
func (s *server) controlSocket(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.currentUser(r); !ok {
		w.WriteHeader(http.StatusUnauthorized)
		s.event("control_websocket_rejected", "remote", r.RemoteAddr, "reason", "unauthorized")
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.event("control_websocket_upgrade_failed", "remote", r.RemoteAddr, "error", err.Error())
		return
	}
	started := time.Now()
	closeReason := "closed"
	s.event("control_websocket_connected", "remote", r.RemoteAddr)
	defer func() {
		s.event("control_websocket_disconnected", "remote", r.RemoteAddr,
			"duration_ms", time.Since(started).Milliseconds(), "reason", closeReason)
	}()
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	})
	// Keep the browser-to-controller control channel alive through public
	// network idle timeouts. Browser WebSocket clients automatically answer
	// ping frames with pong; the pong handler above also detects a dead path.
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(2*time.Second)); err != nil {
					_ = conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()
	for {
		var input map[string]any
		if err := conn.ReadJSON(&input); err != nil {
			closeReason = err.Error()
			return
		}
		body, err := json.Marshal(input)
		if err != nil {
			closeReason = "marshal_input: " + err.Error()
			return
		}
		req := httptest.NewRequest(http.MethodPost, "/api/command/realtime", bytes.NewReader(body))
		req.Header = r.Header.Clone()
		req = req.WithContext(r.Context())
		response := httptest.NewRecorder()
		s.realtimeCommand(response, req)
		var result any
		if json.Unmarshal(response.Body.Bytes(), &result) != nil {
			result = map[string]any{"message": strings.TrimSpace(response.Body.String())}
		}
		if response.Code >= http.StatusBadRequest {
			message := ""
			if resultMap, ok := result.(map[string]any); ok {
				message, _ = resultMap["message"].(string)
			}
			s.event("control_frame_rejected", "device_id", strings.TrimSpace(fmt.Sprint(input["deviceId"])),
				"mode", strings.TrimSpace(fmt.Sprint(input["mode"])),
				"sequence", input["sequence"], "status", response.Code, "message", message)
		}
		frame := map[string]any{
			"status":   response.Code,
			"deviceId": strings.TrimSpace(fmt.Sprint(input["deviceId"])),
			"result":   result,
		}
		if err := conn.WriteJSON(frame); err != nil {
			closeReason = "write_result: " + err.Error()
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	}
}

func (s *server) leaseWatchdog() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		staleDevices := s.hub.RemoveInactive(deviceHeartbeatTimeout)
		if len(staleDevices) > 0 {
			log.Printf("device heartbeat timeout: %s", strings.Join(staleDevices, ", "))
			s.event("device_heartbeat_timeout", "device_ids", staleDevices,
				"timeout_ms", deviceHeartbeatTimeout.Milliseconds())
		}
		expired := s.leases.expire()
		if len(expired) == 0 {
			if len(staleDevices) == 0 {
				continue
			}
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
	if _, ok := s.requireAdmin(w, r); !ok {
		return
	}
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
	// Device firmware downloads happen from the ESP32 and cannot carry the
	// browser's admin session cookie. The OTA command is still admin-only and
	// the image is integrity-checked by the device against the command hash.
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
	if _, ok := s.requireAdmin(w, r); !ok {
		return
	}
	var input struct {
		DeviceID string `json:"deviceId"`
		Name     string `json:"name"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.DeviceID == "" {
		http.Error(w, "设备参数无效", http.StatusBadRequest)
		return
	}
	input.DeviceID = s.connectedDeviceID(input.DeviceID)
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
	if strings.TrimSpace(input.Name) == "" {
		for _, device := range s.hub.List() {
			if strings.EqualFold(device.ID, input.DeviceID) {
				input.Name = device.Name
				break
			}
		}
	}
	if name := strings.TrimSpace(input.Name); name != "" {
		message["payload"].(map[string]any)["name"] = name
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
		Operation  string  `json:"operation"`
		DeviceID   string  `json:"deviceId"`
		SessionID  string  `json:"sessionId"`
		Mode       string  `json:"mode"`
		Frequency  float64 `json:"frequency"`
		Amplitude  float64 `json:"amplitude"`
		Bias       float64 `json:"bias"`
		DurationMs int     `json:"durationMs"`
		OwnerID    string  `json:"ownerId"`
		ClientID   string  `json:"clientId"`
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
	lifetime := time.Duration(0)
	if command.Operation == "motion" || command.Operation == "start" {
		lifetime = visionMotionTimeout
	} else if command.Operation == "calibrate-forward" {
		if command.DurationMs == 0 {
			command.DurationMs = 3200
		}
		if command.DurationMs < 1 || command.DurationMs > 5000 {
			http.Error(w, "标定时长必须为 1–5000 ms", http.StatusBadRequest)
			return
		}
		lifetime = time.Duration(command.DurationMs) * time.Millisecond
	}
	if s.authActive() && !s.isVisionInternalRequest(r) {
		user, ok := s.requireUser(w, r)
		if !ok {
			return
		}
		if !canControl(user) {
			http.Error(w, "需要普通用户或管理员权限", http.StatusForbidden)
			return
		}
	}
	payload := map[string]any{"mode": "stop", "frequency": 0.0, "amplitude": 0.0, "bias": 0.0}
	if command.Operation == "motion" {
		payload["mode"] = command.Mode
		payload["frequency"] = command.Frequency
		payload["amplitude"] = command.Amplitude
		payload["bias"] = command.Bias
		// Keep a device-side safety boundary in addition to the Go vision
		// watchdog. Continuous frames renew this deadline; a stalled controller
		// therefore stops the fish even if the WebSocket remains half-open.
		payload["deadmanMs"] = 2000
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
	deviceID = s.connectedDeviceID(deviceID)
	w.Header().Set("Content-Type", "application/json")
	if !unique {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": false, "acknowledged": false, "success": false,
			"requestId": requestID, "message": "vision control requires a target device ID or exactly one online device",
		})
		return
	}
	payload["transitionMs"] = s.motionTransitionMsForDevice(deviceID)
	if command.Operation == "motion" {
		command.Mode = strings.ToLower(strings.TrimSpace(command.Mode))
		if !isMotionMode(command.Mode) || command.Mode == "stop" {
			http.Error(w, "视觉运动模式无效", http.StatusBadRequest)
			return
		}
		// Vision PID output is continuous and can briefly exceed the
		// physical envelope while the target is far from the path. The
		// controller owns the final device-safe values, so normalize them
		// here instead of silently dropping a tracking frame.
		command.Frequency = limitMotionValue(command.Frequency, 0.3, 5)
		command.Amplitude = limitMotionValue(command.Amplitude, 0, 90)
		command.Bias = limitMotionValue(command.Bias, -90, 90)
		// Vision may request a direction, but the controller owns the final
		// center and amplitude geometry for every control path.
		// Forward PID uses explicit bias for fine steering. Left/right requests
		// mean a real tail-direction mode change, so let calibrated motion
		// geometry choose that side's center instead of neutralizing it with
		// a JSON default bias of 0.
		usesExplicitBias := command.Mode == "forward"
		command.Frequency, command.Amplitude, command.Bias, _ =
			s.applyMotionGeometry(deviceID, command.Mode, command.Frequency, command.Amplitude, command.Bias, usesExplicitBias, nil)
		payload["mode"] = command.Mode
		payload["frequency"] = command.Frequency
		payload["amplitude"] = command.Amplitude
		payload["bias"] = command.Bias
	} else if command.Operation == "calibrate-forward" {
		profile := s.motionProfileForDevice(deviceID)
		percent := profile.ForwardAmplitudePercent * 100.0
		frequency, calibratedAmplitude, bias, _ := s.applyMotionGeometry(deviceID, "forward", profile.ForwardFrequency, 0, 0, false, &percent)
		_, minimumVisibleAmplitude, _, _ := s.applyMotionGeometry(deviceID, "forward", profile.ForwardFrequency, 22.0, 0, true, nil)
		amplitude := math.Max(calibratedAmplitude, minimumVisibleAmplitude)
		payload["frequency"] = frequency
		payload["amplitude"] = amplitude
		payload["bias"] = bias
	}
	payload["controlSource"] = "vision-bot"
	message := map[string]any{
		"type": "command", "requestId": requestID, "ackRequired": true,
		"command": "motion.set", "payload": payload,
	}
	wait := s.commandAckTimeout(deviceID, 700*time.Millisecond, 5*time.Second)
	if command.Operation == "motion" {
		// Continuous frames use the short response path below; a late ACK is
		// reported as pending instead of interrupting the tracker.
		wait = 250 * time.Millisecond
	}
	var receipt *hub.Receipt
	queue := func() bool {
		receipt = s.hub.QueueVisionCommand(deviceID, requestID, message, lifetime, command.SessionID, command.Operation)
		return receipt.Queued()
	}
	admitted := false
	if s.authActive() && s.isVisionInternalRequest(r) && command.OwnerID != "" && command.ClientID != "" {
		admitted = s.leases.admit(deviceID, authUser{ID: command.OwnerID}, command.ClientID, true, queue)
	} else {
		admitted = s.leases.admitVision(deviceID, command.Operation, queue)
	}
	if !admitted {
		if receipt != nil {
			receipt.Wait(0)
		}
		writeAuthError(w, http.StatusConflict, "视觉会话已失效、设备离线或控制权已转移，请重新启动视觉控制")
		return
	}
	s.hub.Notify()
	ack, sent, acknowledged := receipt.Wait(wait)
	if !sent {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": false, "acknowledged": false, "success": false,
			"requestId": requestID, "message": "device offline",
		})
		return
	}
	if !acknowledged {
		// Motion is a continuous stream. Once the WebSocket write completed,
		// waiting for a late ACK must not stop the tracker; the next frame will
		// confirm connectivity and the watchdog still stops a stale session.
		if command.Operation == "motion" && sent {
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sent": true, "acknowledged": false, "success": true, "pending": true,
				"requestId": requestID, "message": "运动指令已发送，设备确认仍在返回",
			})
			return
		}
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
	ack["sent"] = true
	ack["acknowledged"] = true
	_ = json.NewEncoder(w).Encode(ack)
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "service": "fish-controller"})
}

// status is a lightweight readiness snapshot for the frontend and startup
// checks. It exposes service reachability, not credentials or lease owners.
func (s *server) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET", http.StatusMethodNotAllowed)
		return
	}
	vision := map[string]any{"available": false}
	if strings.TrimSpace(s.visionAPIAddress) != "" && s.visionHTTPClient != nil {
		client := *s.visionHTTPClient
		client.Timeout = 750 * time.Millisecond
		response, err := client.Get(s.visionAPIAddress + "/health")
		if err == nil {
			response.Body.Close()
			vision["available"] = response.StatusCode >= 200 && response.StatusCode < 300
		}
	}
	devices := s.hub.List()
	online := 0
	for _, device := range devices {
		if device.Online {
			online++
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "ok", "apiVersion": 1, "frontend": "competition", "serverTime": time.Now().UTC(),
		"devices": map[string]any{"total": len(devices), "online": online},
		"vision":  vision,
		"control": map[string]any{"transport": "websocket", "endpoint": "/ws/control"},
	})
}

// logsAPI exposes a bounded tail of the current diagnostic JSONL session.
// Logs are operational data and may contain network/device identifiers, so
// this endpoint is administrator-only and never returns the whole file.
func (s *server) logsAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET", http.StatusMethodNotAllowed)
		return
	}
	if _, ok := s.requireAdmin(w, r); !ok {
		return
	}
	limit := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			limit = value
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 500 {
		limit = 500
	}
	root := strings.TrimSpace(os.Getenv("FISH_DIAGNOSTIC_DIR"))
	if root == "" {
		root = filepath.Join("diagnostics", "runs")
	}
	sessionID := ""
	if data, err := os.ReadFile(filepath.Join(root, "LATEST.txt")); err == nil {
		sessionID = strings.TrimSpace(string(data))
	}
	entries := make([]map[string]any, 0, limit)
	path := filepath.Join(root, sessionID, "controller.jsonl")
	if sessionID != "" {
		file, err := os.Open(path)
		if err == nil {
			defer file.Close()
			ring := make([]map[string]any, 0, limit)
			scanner := bufio.NewScanner(file)
			scanner.Buffer(make([]byte, 4096), 1<<20)
			for scanner.Scan() {
				var entry map[string]any
				if json.Unmarshal(scanner.Bytes(), &entry) != nil {
					continue
				}
				if len(ring) == limit {
					copy(ring, ring[1:])
					ring = ring[:limit-1]
				}
				ring = append(ring, entry)
			}
			entries = ring
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"sessionId": sessionID,
		"limit":     limit,
		"entries":   entries,
	})
}

// connectedDeviceID resolves a persisted/requested MAC to the exact ID used
// by the live WebSocket entry. Names are deliberately ignored: they are only
// display labels and must never become command addresses.
func (s *server) connectedDeviceID(requested string) string {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return ""
	}
	for _, device := range s.hub.List() {
		if strings.EqualFold(strings.TrimSpace(device.ID), requested) {
			return device.ID
		}
	}
	return requested
}

func (s *server) devices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET", http.StatusMethodNotAllowed)
		return
	}
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
		http.Error(w, "需要普通用户或管理员权限", http.StatusForbidden)
		return
	}
	var input struct {
		DeviceID string `json:"deviceId"`
		ClientID string `json:"clientId"`
		Mode     string `json:"mode"`
		Slot     string `json:"slot"`
		Force    bool   `json:"force"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeAuthError(w, http.StatusBadRequest, "控制权请求格式错误")
			return
		}
	}
	input.DeviceID = strings.TrimSpace(input.DeviceID)
	input.DeviceID = s.connectedDeviceID(input.DeviceID)
	if input.DeviceID == "" {
		http.Error(w, "设备参数无效", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case http.MethodPatch:
		if !s.leases.admit(input.DeviceID, user, input.ClientID, true, func() bool { return true }) {
			s.event("lease_renew_conflict", "device_id", input.DeviceID, "client_id", input.ClientID, "owner_id", user.ID)
			writeAuthError(w, http.StatusConflict, "控制权已失效，请重新获取控制权")
			return
		}
		s.event("lease_renewed", "device_id", input.DeviceID, "client_id", input.ClientID, "owner_id", user.ID)
		_ = json.NewEncoder(w).Encode(map[string]any{"renewed": true})
	case http.MethodPost:
		if strings.EqualFold(strings.TrimSpace(input.Mode), "player") &&
			!s.playerControlAllowed(input.DeviceID, input.Slot) {
			writeAuthError(w, http.StatusConflict, "场地尚未锁定，或该机器鱼未分配给当前席位")
			return
		}
		// Administrators are the management authority for every control path,
		// including the player-mode binding used by the public competition UI.
		// A stale browser tab must not leave the live device permanently
		// unclaimable. acquireExclusive() queues a neutral stop before replacing
		// the old lease, so takeover cannot leave two motion owners active.
		forceTakeover := canAdmin(user)
		lease, _, acquired := s.leases.acquireExclusive(input.DeviceID, user, input.Mode, forceTakeover, input.ClientID)
		if !acquired {
			sameAccount := lease.OwnerID == user.ID
			s.event("lease_acquire_conflict", "device_id", input.DeviceID, "client_id", input.ClientID,
				"owner_id", user.ID, "current_owner_id", lease.OwnerID, "current_client_id", lease.ClientID,
				"same_account", sameAccount)
			w.WriteHeader(http.StatusConflict)
			message := "这条鱼正在被其他用户控制"
			if sameAccount {
				message = "该账号已有其他客户端连接，请先关闭旧客户端或等待租约过期"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"acquired": false, "lease": lease, "message": message})
			return
		}
		// A new lease/browser session starts its realtime sequence at one. The
		// previous sequence belongs to the old control session and must not reject
		// the first frame from the newly bound page.
		s.hub.ResetLatestSequence(input.DeviceID)
		s.event("lease_acquired", "device_id", input.DeviceID, "client_id", input.ClientID,
			"owner_id", user.ID, "mode", input.Mode, "slot", input.Slot, "force", forceTakeover)
		s.hub.Notify()
		_ = json.NewEncoder(w).Encode(map[string]any{"acquired": true, "lease": lease})
	case http.MethodDelete:
		released := s.leases.release(input.DeviceID, user, canAdmin(user), input.ClientID)
		if !released {
			s.event("lease_release_conflict", "device_id", input.DeviceID, "client_id", input.ClientID, "owner_id", user.ID)
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"released": false, "message": "只能释放自己的控制权，管理员可强制释放"})
			return
		}
		s.event("lease_released", "device_id", input.DeviceID, "client_id", input.ClientID, "owner_id", user.ID)
		s.hub.Notify()
		_ = json.NewEncoder(w).Encode(map[string]any{"released": true})
	default:
		http.Error(w, "仅支持 POST / PATCH / DELETE", http.StatusMethodNotAllowed)
	}
}

func (s *server) emergencyStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	user, ok := s.requireAdmin(w, r)
	if !ok {
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
	receipts := make([]*hub.Receipt, 0, len(devices))
	for _, device := range devices {
		requestID := fmt.Sprintf("emergency-%d", time.Now().UnixNano())
		message := map[string]any{"type": "command", "requestId": requestID, "command": "emergency.stop", "payload": map[string]any{"operator": user.Email}}
		s.leases.mu.Lock()
		s.hub.StopAndReset(device.ID)
		receipts = append(receipts, s.hub.QueueCommand(device.ID, requestID, message, 0))
		s.leases.mu.Unlock()
	}
	s.hub.Notify()
	for i, receipt := range receipts {
		ack, sent, acknowledged := receipt.Wait(1200 * time.Millisecond)
		item := result{DeviceID: devices[i].ID, Sent: sent, Acknowledged: acknowledged}
		if acknowledged {
			item.Success, _ = ack["success"].(bool)
			item.Message, _ = ack["message"].(string)
		}
		results = append(results, item)
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

func limitMotionValue(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func (s *server) stopDevice(deviceID string) bool {
	requestID := fmt.Sprintf("lease-stop-%d", time.Now().UnixNano())
	message := map[string]any{
		"type": "command", "requestId": requestID,
		"command": "motion.set",
		"payload": map[string]any{
			"controlSource": "lease",
			"mode":          "stop", "frequency": 0.3, "amplitude": 0.0, "bias": 0.0,
		},
	}
	_, sent, _ := s.hub.SendAndWait(deviceID, requestID, message, 700*time.Millisecond)
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

func isMotionMode(mode string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "stop", "idle", "forward", "left", "right":
		return true
	default:
		return false
	}
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
		} else if mode == "left" || mode == "right" {
			// Both turns use half of the smaller straight-side offset. Computing
			// available swing around each turn center made left/right asymmetric
			// when the calibrated straight center was not 90 degrees.
			swing = balancedTurnOffset
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

func motionStraightCenter(profile motionCalibrationProfile) float64 {
	if profile.ServoMax != 0 || profile.StraightCenter != 0 || profile.ForwardFrequency != 0 {
		_, _, center := profileServoRange(profile)
		return center
	}
	return clampMotionValue(profile.CenterDeg, 0, 180, 90)
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

func (s *server) motionTransitionMsForDevice(deviceID string) float64 {
	profile := s.motionProfileForDevice(deviceID)
	return clampMotionValue(profile.TransitionMs, 100, 1500, 600)
}

func (s *server) applyMotionGeometry(deviceID, mode string, frequency, amplitude, bias float64, hasBias bool, amplitudePercent *float64) (float64, float64, float64, bool) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode != "forward" && mode != "left" && mode != "right" && mode != "idle" && mode != "stop" {
		return frequency, amplitude, bias, hasBias
	}
	profile := s.motionProfileForDevice(deviceID)
	straightCenter := motionStraightCenter(profile)
	minimum, maximum := 0.0, 180.0
	if profile.ServoMax != 0 || profile.StraightCenter != 0 || profile.ForwardFrequency != 0 {
		minimum, maximum, _ = profileServoRange(profile)
	}
	center, maxSwing, ok := centerSwingForMode(profile, mode)
	if !ok {
		// Legacy profiles have no forward/idle geometry or calibrated limits.
		// Preserve their requested swing, subject to the physical 0–180° range.
		center, maxSwing = straightCenter, 90
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
		// The firmware stores the straight center as its neutral position.
		// Motion bias is therefore relative to that calibrated center, not 90°.
		bias = center - straightCenter
	}
	if mode == "stop" {
		bias = 0
	}
	// Explicit PID/manual bias changes the actual swing center. Limit that
	// center first, then fit the whole oscillation within the servo envelope.
	bias = limitMotionValue(bias, math.Max(-90, minimum-straightCenter), math.Min(90, maximum-straightCenter))
	actualCenter := straightCenter + bias
	availableSwing := math.Max(0, math.Min(actualCenter-minimum, maximum-actualCenter))
	amplitude = limitMotionValue(amplitude, 0, availableSwing)
	return frequency, amplitude, bias, true
}

func (s *server) motionCalibrations(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canControl(user) {
		http.Error(w, "需要普通用户或管理员权限", http.StatusForbidden)
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
		http.Error(w, "需要普通用户或管理员权限", http.StatusForbidden)
		return
	}
	var x struct {
		DeviceID, Mode, ClientID string
		Frequency, Amplitude     float64
		AmplitudePercent, Bias   *float64
	}
	if json.NewDecoder(r.Body).Decode(&x) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	x.DeviceID = s.connectedDeviceID(x.DeviceID)
	if x.DeviceID == "" || x.Frequency < 0.3 || x.Frequency > 5 || x.Amplitude < 0 || x.Amplitude > 90 || (x.AmplitudePercent != nil && (*x.AmplitudePercent < 0 || *x.AmplitudePercent > 100)) || (x.Bias != nil && (*x.Bias < -90 || *x.Bias > 90)) {
		http.Error(w, "参数无效", http.StatusBadRequest)
		return
	}
	mode := strings.ToLower(x.Mode)
	if mode != "center" && !isMotionMode(mode) {
		http.Error(w, "运动模式无效", http.StatusBadRequest)
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
		"controlSource": "manual",
		"mode":          mode, "frequency": x.Frequency,
		"amplitude": x.Amplitude, "transitionMs": s.motionTransitionMsForDevice(x.DeviceID),
	}
	if mode == "stop" {
		// A stop is an explicit neutral command. Never inherit the previous turn bias.
		x.Frequency = 0.3
		x.Amplitude = 0
		bias = 0
		hasBias = true
		payload["frequency"] = x.Frequency
		payload["amplitude"] = x.Amplitude
		payload["transitionMs"] = 100
	}
	if hasBias {
		payload["bias"] = bias
	}
	if mode == "stop" {
		payload["transitionMs"] = 100
	}
	msg := map[string]any{
		"type": "command", "requestId": requestID, "command": "motion.set",
		"payload": payload,
	}
	w.Header().Set("Content-Type", "application/json")
	var receipt *hub.Receipt
	required := mode != "stop" && (x.ClientID != "" || s.authActive())
	if !s.leases.admit(x.DeviceID, user, x.ClientID, required, func() bool {
		receipt = s.hub.QueueCommand(x.DeviceID, requestID, msg, 0)
		return receipt.Queued()
	}) {
		if receipt != nil {
			receipt.Wait(0)
		}
		writeAuthError(w, http.StatusConflict, "设备离线或控制权已转移，请重新获取控制权")
		return
	}
	s.leases.setDeadmanProtected(x.DeviceID, user, x.ClientID, false)
	ack, sent, acknowledged := receipt.Wait(s.commandAckTimeout(x.DeviceID, 2500*time.Millisecond, 8*time.Second))
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
	} else if _, exists := ack["applied"]; !exists {
		// Protocol v2 keeps device acknowledgements small. Preserve the HTTP API
		// contract by returning the command parameters already validated here.
		ack["applied"] = payload
	}
	ack["sent"] = true
	ack["acknowledged"] = true
	_ = json.NewEncoder(w).Encode(ack)
}

// realtimeCommand is used by keyboard control. It returns immediately so the
// keyboard loop stays responsive. Realtime frames are deliberately fire-and-
// forget: the browser sends a fresh frame every 100 ms and the device's
// deadman timer provides the safety boundary. Requiring an acknowledgement
// here would make the firmware reject frames that have no requestId.
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
		http.Error(w, "需要普通用户或管理员权限", http.StatusForbidden)
		return
	}
	var x struct {
		DeviceID, Mode, ClientID, Context string
		Frequency, Amplitude              float64
		AmplitudePercent, Bias            *float64
		Sequence                          uint64
		DeadmanMs                         int
	}
	if json.NewDecoder(r.Body).Decode(&x) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	x.DeviceID = s.connectedDeviceID(x.DeviceID)
	if x.DeviceID == "" || x.Frequency < 0.3 || x.Frequency > 5 ||
		x.Amplitude < 0 || x.Amplitude > 90 ||
		x.DeadmanMs < 0 || x.DeadmanMs > 2000 || (x.DeadmanMs > 0 && x.DeadmanMs < 150) ||
		(x.AmplitudePercent != nil && (*x.AmplitudePercent < 0 || *x.AmplitudePercent > 100)) ||
		(x.Bias != nil && (*x.Bias < -90 || *x.Bias > 90)) {
		http.Error(w, "参数无效", http.StatusBadRequest)
		return
	}
	mode := strings.ToLower(x.Mode)
	if !isMotionMode(mode) {
		http.Error(w, "运动模式无效", http.StatusBadRequest)
		return
	}
	// Match state is presentation and scoring state, not a motion interlock.
	// Operators must be able to recover, test, or move a fish before a match,
	// while paused, and after it finishes. Device ownership, online state and
	// OTA safety checks below remain the authority for accepting commands.
	var bias float64
	hasBias := x.Bias != nil
	if hasBias {
		bias = *x.Bias
	}
	if mode == "stop" {
		// Stop is always an explicit neutral command; never inherit a turn bias.
		x.Frequency = 0.3
		x.Amplitude = 0
		bias = 0
		hasBias = true
	}
	x.Frequency, x.Amplitude, bias, hasBias =
		s.applyMotionGeometry(x.DeviceID, mode, x.Frequency, x.Amplitude, bias, hasBias, x.AmplitudePercent)
	requestID := fmt.Sprintf("realtime-%d", time.Now().UnixNano())
	payload := map[string]any{
		"controlSource": "manual",
		"mode":          mode, "frequency": x.Frequency,
		"amplitude": x.Amplitude, "transitionMs": s.motionTransitionMsForDevice(x.DeviceID),
	}
	if hasBias {
		payload["bias"] = bias
	}
	if mode != "stop" && x.DeadmanMs > 0 {
		payload["deadmanMs"] = x.DeadmanMs
	}
	message := map[string]any{
		"type": "command",
		// Realtime frames are deliberately fire-and-forget. Do not include a
		// requestId: firmware only sends command.result when one is present,
		// and suppressing those replies keeps multi-device control responsive.
		"command": "motion.set", "ackRequired": false, "payload": payload,
	}
	required := mode != "stop" && (x.ClientID != "" || s.authActive())
	if !s.leases.admit(x.DeviceID, user, x.ClientID, required, func() bool {
		if mode == "stop" {
			lease, exists := s.leases.leases[x.DeviceID]
			if (exists && (lease.ClientID != x.ClientID || lease.OwnerID != user.ID)) || (!exists && x.ClientID != "") {
				x.Sequence = 0 // Another browser's STOP cannot poison this owner's sequence.
			}
			return s.hub.SendLatestStop(x.DeviceID, x.Sequence, message)
		}
		return s.hub.SendLatestOrdered(x.DeviceID, x.Sequence, message)
	}) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sent": false, "queued": false, "success": false,
			"requestId": requestID, "message": "实时命令已过期或设备离线",
		})
		return
	}
	s.leases.setDeadmanProtected(x.DeviceID, user, x.ClientID, x.DeadmanMs > 0 || mode == "stop")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"sent": true, "queued": true, "acknowledged": false,
		"success": true, "requestId": requestID, "applied": payload,
	})
}

func (s *server) authenticatedVisionProxy(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := s.requireUser(w, r)
		if !ok {
			return
		}
		r.Header.Del("X-Fish-Workspace-User")
		r.Header.Del("X-Fish-Workspace-Client")
		prefix := "/api/vision/workspaces/"
		if strings.HasPrefix(r.URL.Path, prefix) {
			rest := strings.TrimPrefix(r.URL.Path, prefix)
			parts := strings.SplitN(rest, "/", 2)
			clientID := strings.TrimSpace(r.Header.Get("X-Fish-Client"))
			if clientID == "" {
				clientID = strings.TrimSpace(r.URL.Query().Get("clientId"))
			}
			if len(parts) != 2 || parts[0] == "" || clientID == "" || !canControl(user) {
				writeAuthError(w, http.StatusForbidden, "视觉工作区身份无效")
				return
			}
			lease, exists := s.leases.snapshot()[parts[0]]
			if !exists || lease.OwnerID != user.ID || lease.ClientID != clientID {
				writeAuthError(w, http.StatusConflict, "请先在当前浏览器取得该机器鱼的控制权")
				return
			}
			r.Header.Set("X-Fish-Workspace-User", user.ID)
			r.Header.Set("X-Fish-Workspace-Client", clientID)
		} else if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !canAdmin(user) {
				writeAuthError(w, http.StatusForbidden, "共享视觉设置需要管理员权限")
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

func (s *server) deviceSocket(w http.ResponseWriter, r *http.Request) {
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.event("device_websocket_upgrade_failed", "remote", r.RemoteAddr, "error", err.Error())
		return
	}
	c := &deviceConn{conn: rawConn}
	defer c.Close()
	connectedAt := time.Now()
	deviceID := ""
	closeReason := "closed_before_register"
	var closeReasonMu sync.Mutex
	setCloseReason := func(reason string) {
		closeReasonMu.Lock()
		closeReason = reason
		closeReasonMu.Unlock()
	}
	getCloseReason := func() string {
		closeReasonMu.Lock()
		defer closeReasonMu.Unlock()
		return closeReason
	}
	defer func() {
		s.event("device_websocket_closed", "device_id", deviceID, "remote", r.RemoteAddr,
			"duration_ms", time.Since(connectedAt).Milliseconds(), "reason", getCloseReason())
	}()
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		setCloseReason("nonce: " + err.Error())
		return
	}
	nonce := hex.EncodeToString(nonceBytes)
	if c.WriteJSON(map[string]any{"type": "auth.challenge", "protocolVersion": 2, "nonce": nonce}) != nil {
		setCloseReason("challenge_write_failed")
		return
	}
	var reg map[string]any
	_ = rawConn.SetReadDeadline(time.Now().Add(deviceHeartbeatTimeout))
	if err := rawConn.ReadJSON(&reg); err != nil {
		setCloseReason("register_read: " + err.Error())
		return
	}
	id, _ := reg["deviceId"].(string)
	deviceID = strings.TrimSpace(id)
	proof, _ := reg["proof"].(string)
	version, _ := reg["protocolVersion"].(float64)
	if id == "" || version != 2 || !identity.Verify(s.key, "fish-websocket-v2", nonce, id, proof) {
		_ = c.WriteJSON(map[string]any{"type": "register.result", "success": false})
		setCloseReason("register_rejected")
		s.event("device_register_rejected", "device_id", deviceID, "remote", r.RemoteAddr, "protocol_version", version)
		return
	}
	d := hub.Device{
		ID: id, Name: text(reg["name"]), IP: text(reg["ip"]),
		FirmwareVersion: text(reg["firmwareVersion"]),
		ProtocolVersion: int(version), BootID: text(reg["bootId"]),
		Capabilities: texts(reg["capabilities"]),
	}
	if sensors, ok := reg["sensors"].([]any); ok {
		for _, value := range sensors {
			if sensor, ok := value.(string); ok && sensor != "" {
				d.Sensors = append(d.Sensors, sensor)
			}
		}
	}
	if pin, ok := reg["servoPin"].(float64); ok && pin >= 0 && pin <= 48 {
		d.ServoPin = int(pin)
	}
	if pin, ok := reg["statusLedPin"].(float64); ok && pin >= 0 && pin <= 48 {
		d.StatusLedPin = int(pin)
	}
	if pin, ok := reg["batterySensePin"].(float64); ok && pin >= 0 && pin <= 48 {
		d.BatterySensePin = int(pin)
	}
	if ratio, ok := reg["batteryDividerRatio"].(float64); ok && ratio > 0 && ratio < 100 {
		d.BatteryDividerRatio = ratio
	}
	if voltage, ok := reg["batteryEmptyVoltage"].(float64); ok && voltage >= 0 && voltage < 100 {
		d.BatteryEmptyVoltage = voltage
	}
	if voltage, ok := reg["batteryFullVoltage"].(float64); ok && voltage >= 0 && voltage < 100 {
		d.BatteryFullVoltage = voltage
	}
	if center, ok := reg["servoCenter"].(float64); ok && center >= 0 && center <= 180 {
		d.ServoCenter = center
	}
	if addresses, ok := reg["i2cAddresses"].([]any); ok {
		for _, value := range addresses {
			if address, ok := value.(float64); ok && address > 0 && address < 127 {
				d.I2CAddresses = append(d.I2CAddresses, int(address))
			}
		}
	}
	// Complete the protocol handshake before exposing the device to command
	// handlers. Otherwise a concurrent HTTP request could enqueue a command
	// before the ESP32 has received register.result and it would ignore it.
	if c.WriteJSON(map[string]any{"type": "register.result", "success": true}) != nil {
		setCloseReason("register_ack_write_failed")
		return
	}
	s.hub.Register(d, c)
	log.Printf("device registered: %s (%s), source %s", id, d.IP, r.RemoteAddr)
	s.event("device_connected", "device_id", id, "ip", d.IP, "remote", r.RemoteAddr,
		"protocol_version", d.ProtocolVersion, "firmware_version", d.FirmwareVersion, "boot_id", d.BootID)
	defer s.hub.Remove(id, c)
	rawConn.SetPongHandler(func(payload string) error {
		sentAt, parseErr := strconv.ParseInt(payload, 10, 64)
		rtt := time.Duration(0)
		if parseErr == nil {
			rtt = time.Since(time.Unix(0, sentAt))
			if rtt >= 0 && rtt <= deviceHeartbeatTimeout {
				s.hub.TouchHeartbeat(id, rtt)
			}
		} else {
			// A pong without a timestamp still proves that the transport is
			// alive; do not let it age out of the device registry.
			s.hub.TouchHeartbeat(id, -1)
		}
		return rawConn.SetReadDeadline(time.Now().Add(deviceHeartbeatTimeout))
	})
	_ = rawConn.SetReadDeadline(time.Now().Add(deviceHeartbeatTimeout))
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := c.WritePing(strconv.FormatInt(time.Now().UnixNano(), 10)); err != nil {
					log.Printf("device ping failed: %s: %v", id, err)
					s.event("device_ping_failed", "device_id", id, "error", err.Error())
					setCloseReason("ping_failed: " + err.Error())
					_ = c.Close()
					return
				}
				if !s.hub.Send(id, map[string]any{"type": "heartbeat"}) {
					log.Printf("device heartbeat failed: %s", id)
					s.event("device_heartbeat_send_failed", "device_id", id)
					setCloseReason("heartbeat_send_failed")
					_ = c.Close()
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
			setCloseReason(err.Error())
			s.event("device_disconnected", "device_id", id, "error", err.Error())
			return
		}
		_ = rawConn.SetReadDeadline(time.Now().Add(deviceHeartbeatTimeout))
		messageType, _ := msg["type"].(string)
		if messageType == "command.result" {
			s.hub.ResolveCommandResult(msg)
		}
		switch messageType {
		case "heartbeat", "state", "motion.state", "rgb.state",
			"telemetry.battery", "telemetry.light", "telemetry.link",
			"identity", "ota.progress", "command.result":
			s.hub.Update(id, msg)
		}
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

// dashboard was replaced by the static file server registered in
// newHandler, which serves every page in the embedded dist.
