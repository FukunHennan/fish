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

type server struct {
	hub          *hub.Hub
	key          []byte
	firmwarePath string
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
	for _, path := range []string{filepath.Join("..", "firmware", ".pio", "build", "seeed_xiao_esp32c3", "firmware.bin"), filepath.Join("firmware", ".pio", "build", "seeed_xiao_esp32c3", "firmware.bin")} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func newHandler(h *hub.Hub, key []byte, apiAddress, streamAddress, firmwarePath string) http.Handler {
	s := &server{hub: h, key: append([]byte(nil), key...), firmwarePath: firmwarePath}
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
	m.HandleFunc("/api/firmware/current.bin", s.firmware)
	m.HandleFunc("/api/vision/device-command", s.visionDeviceCommand)
	m.Handle("/api/vision/", visionHandler)
	m.HandleFunc("/ws/device", s.deviceSocket)
	return m
}

func (s *server) firmware(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "仅支持 GET", http.StatusMethodNotAllowed)
		return
	}
	if s.firmwarePath == "" {
		http.Error(w, "固件尚未构建", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, s.firmwarePath)
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
	data, err := os.ReadFile(s.firmwarePath)
	if err != nil || len(data) < 4 || data[0] != 0xE9 {
		http.Error(w, "固件不可用或格式错误", http.StatusConflict)
		return
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	requestID := fmt.Sprintf("ota-%d", time.Now().UnixNano())
	sent := s.hub.Send(input.DeviceID, map[string]any{"type": "command", "requestId": requestID, "command": "ota.start", "payload": map[string]any{"sha256": hash, "size": len(data)}})
	w.Header().Set("Content-Type", "application/json")
	if !sent {
		w.WriteHeader(http.StatusConflict)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"sent": sent, "requestId": requestID, "sha256": hash, "size": len(data)})
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
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
func (s *server) devices(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.hub.List())
}
func (s *server) command(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "仅支持 POST", 405)
		return
	}
	var x struct {
		DeviceID, Mode       string
		Frequency, Amplitude float64
		Bias                 float64
	}
	if json.NewDecoder(r.Body).Decode(&x) != nil {
		http.Error(w, "请求格式错误", 400)
		return
	}
	if x.DeviceID == "" || x.Frequency < 0.3 || x.Frequency > 5 || x.Amplitude < 0 || x.Amplitude > 50 || x.Bias < -45 || x.Bias > 45 {
		http.Error(w, "参数无效", 400)
		return
	}
	requestID := fmt.Sprintf("%d", time.Now().UnixNano())
	msg := map[string]any{"type": "command", "requestId": requestID, "command": "motion.set", "payload": map[string]any{"mode": strings.ToLower(x.Mode), "frequency": x.Frequency, "amplitude": x.Amplitude, "bias": x.Bias}}
	ok := s.hub.Send(x.DeviceID, msg)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"sent": ok, "requestId": requestID})
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
		c.WriteJSON(map[string]any{"type": "register.result", "success": false})
		return
	}
	d := hub.Device{ID: id, Name: text(reg["name"]), IP: text(reg["ip"]), FirmwareVersion: text(reg["firmwareVersion"])}
	s.hub.Register(d, c)
	log.Printf("设备已注册：%s (%s)，来源 %s", id, d.IP, r.RemoteAddr)
	defer s.hub.Remove(id, c)
	c.WriteJSON(map[string]any{"type": "register.result", "success": true})
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := c.WriteJSON(map[string]any{"type": "heartbeat"}); err != nil {
					log.Printf("设备心跳发送失败：%s: %v", id, err)
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
			log.Printf("设备连接断开：%s: %v", id, err)
			return
		}
		s.hub.Update(id, msg)
	}
}
func text(v any) string { s, _ := v.(string); return s }

const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>机器鱼控制台</title><style>body{font-family:sans-serif;max-width:760px;margin:30px auto;padding:16px;background:#f4f7fb;color:#172033}.card{background:white;padding:18px;border-radius:12px;margin:12px 0}button{padding:12px 18px;margin:5px;border:0;border-radius:8px;background:#1677ff;color:white}.stop{background:#e53935}input{padding:9px;width:80px}.muted{color:#65758b}</style></head><body><h1>机器鱼控制台</h1><p class="muted">最小功能测试界面</p><div id="list">正在等待设备……</div><script>let devices=[];async function load(){devices=await fetch('/api/devices').then(r=>r.json());render()}function render(){let e=document.getElementById('list');if(!devices.length){e.innerHTML='<div class="card">暂无设备，请确认机器鱼和电脑处于同一局域网。</div>';return}e.innerHTML=devices.map((d,i)=>'<div class="card"><h3>'+d.name+' '+(d.online?'🟢':'⚫')+'</h3><div>'+d.deviceId+' · '+d.ip+' · 固件 '+d.firmwareVersion+'</div><p>频率 <input id="f'+i+'" value="'+(d.frequency||2.5)+'" type="number" step="0.1"> 幅度 <input id="a'+i+'" value="'+(d.amplitude||28)+'" type="number"></p><button onclick="send('+i+',\'forward\')">前进</button><button onclick="send('+i+',\'left\')">左转</button><button onclick="send('+i+',\'right\')">右转</button><button onclick="send('+i+',\'idle\')">待机</button><button class="stop" onclick="send('+i+',\'stop\')">停止</button><p id="s'+i+'" class="muted">RSSI '+d.rssi+'</p></div>').join('')}async function send(i,m){let d=devices[i],body={deviceId:d.deviceId,mode:m,frequency:+document.getElementById('f'+i).value,amplitude:+document.getElementById('a'+i).value};let r=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let x=await r.json();document.getElementById('s'+i).textContent=x.sent?'命令已发送':'设备不在线'}setInterval(load,1000);load()</script></body></html>`

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
