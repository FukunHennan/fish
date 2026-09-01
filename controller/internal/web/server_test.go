package web

import (
	"crypto/sha256"
	"encoding/json"
	"fish-controller/internal/hub"
	"fish-controller/internal/identity"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestMain(m *testing.M) {
	_ = os.Setenv("FISH_AUTH_DISABLED", "true")
	os.Exit(m.Run())
}

func TestOtaEndpointServesFirmwareAndSendsVerifiedMetadata(t *testing.T) {
	firmware := []byte{0xE9, 0x01, 0x02, 0x03}
	path := t.TempDir() + "/firmware.bin"
	if err := os.WriteFile(path, firmware, 0600); err != nil {
		t.Fatal(err)
	}
	h := hub.New()
	connection := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		h.ResolveCommandResult(map[string]any{"type": "command.result", "requestId": message["requestId"], "success": true, "code": "OK", "message": "installed"})
	}}
	h.Register(hub.Device{ID: "fish-1"}, connection)
	handler := NewHandlerWithFirmware(h, testKey(), path)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/firmware/current.bin", nil))
	if w.Code != 200 || string(w.Body.Bytes()) != string(firmware) {
		t.Fatalf("固件下载异常: %d", w.Code)
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/ota", strings.NewReader(`{"deviceId":"fish-1"}`)))
	if w.Code != 200 || len(connection.sent) != 1 {
		t.Fatalf("OTA 命令异常: %d %s", w.Code, w.Body.String())
	}
	message := connection.sent[0].(map[string]any)
	payload := message["payload"].(map[string]any)
	expected := fmt.Sprintf("%x", sha256.Sum256(firmware))
	if message["command"] != "ota.start" || payload["sha256"] != expected || payload["size"] != len(firmware) {
		t.Fatalf("OTA 元数据错误: %#v", message)
	}
	var otaResponse map[string]any
	if json.Unmarshal(w.Body.Bytes(), &otaResponse) != nil || otaResponse["acknowledged"] != true || otaResponse["success"] != true {
		t.Fatalf("OTA response did not include device acknowledgement: %s", w.Body.String())
	}
}

type captureConn struct {
	sent    []any
	onWrite func(any)
}

func (c *captureConn) WriteJSON(v any) error {
	c.sent = append(c.sent, v)
	if c.onWrite != nil {
		c.onWrite(v)
	}
	return nil
}
func (c *captureConn) Close() error { return nil }

func testKey() []byte { return make([]byte, 32) }

func TestHealthAndDashboard(t *testing.T) {
	handler := NewHandler(hub.New(), testKey())
	for _, tc := range []struct{ path, contains string }{{"/healthz", "ok"}, {"/", "机器鱼控制台"}} {
		r := httptest.NewRequest("GET", tc.path, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 || !strings.Contains(w.Body.String(), tc.contains) {
			t.Fatalf("%s 返回异常: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
}

func TestVisionRoutesUseConfiguredProxy(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			t.Fatalf("视觉路径 = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"state":"running"}`))
	}))
	defer api.Close()
	stream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("video"))
	}))
	defer stream.Close()

	handler := NewHandlerWithVision(hub.New(), testKey(), api.URL, stream.URL)
	r := httptest.NewRequest(http.MethodGet, "/api/vision/status", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Body.String() != `{"state":"running"}` {
		t.Fatalf("视觉代理返回异常: %d %q", w.Code, w.Body.String())
	}
}

func TestVisionDeviceCommandRoutesToOnlyConnectedFish(t *testing.T) {
	h := hub.New()
	connection := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		h.ResolveCommandResult(map[string]any{
			"type": "command.result", "requestId": message["requestId"],
			"success": true, "code": "OK", "message": "applied",
		})
	}}
	h.Register(hub.Device{ID: "fish-1"}, connection)
	handler := NewHandler(h, testKey())
	body := `{"operation":"update","sessionId":"session-1","sequence":7,"crossTrackError":0.2,"headingErrorDeg":-12,"distanceToTarget":0.8,"speed":0.1,"curvature":0.3,"brake":false}`
	r := httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("状态=%d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"acknowledged":true`) {
		t.Fatalf("响应没有设备确认: %s", w.Body.String())
	}
	if len(connection.sent) != 1 {
		t.Fatalf("发送数量=%d", len(connection.sent))
	}
	message := connection.sent[0].(map[string]any)
	if message["command"] != "vision.update" {
		t.Fatalf("命令=%v", message["command"])
	}
	payload := message["payload"].(map[string]any)
	if payload["sequence"] != uint32(7) || payload["headingErrorDeg"] != -12.0 {
		t.Fatalf("载荷=%+v", payload)
	}
}

func TestVisionDeviceCommandFailsWhenDeviceDoesNotAcknowledge(t *testing.T) {
	h := hub.New()
	h.Register(hub.Device{ID: "fish-1"}, &captureConn{})
	handler := NewHandler(h, testKey())
	r := httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(
		`{"operation":"calibrate-forward","sessionId":"session-1"}`,
	))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusGatewayTimeout || !strings.Contains(w.Body.String(), `"acknowledged":false`) {
		t.Fatalf("未确认命令应超时: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestVisionDeviceCommandRoutesToExplicitTargetAmongMultipleFish(t *testing.T) {
	h := hub.New()
	first := &captureConn{}
	second := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		h.ResolveCommandResult(map[string]any{"type": "command.result", "requestId": message["requestId"], "success": true, "code": "OK", "message": "applied"})
	}}
	h.Register(hub.Device{ID: "fish-1"}, first)
	h.Register(hub.Device{ID: "fish-2"}, second)
	handler := NewHandler(h, testKey())
	r := httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(
		`{"operation":"calibrate-forward","deviceId":"fish-2","sessionId":"session-1","durationMs":3600}`,
	))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK || len(first.sent) != 0 || len(second.sent) != 1 {
		t.Fatalf("explicit target routing failed: status=%d first=%d second=%d body=%s", w.Code, len(first.sent), len(second.sent), w.Body.String())
	}
	payload := second.sent[0].(map[string]any)["payload"].(map[string]any)
	if payload["durationMs"] != uint32(3600) {
		t.Fatalf("durationMs=%v", payload["durationMs"])
	}
}

func TestMotionCalibrationProfilesPersistPerDevice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "motion-calibrations.json")
	t.Setenv("FISH_MOTION_CALIBRATIONS", path)
	handler := NewHandler(hub.New(), testKey())
	body := `{"deviceId":"fish-2","centerDeg":94,"frequency":2.4,"amplitude":26,"leftSign":-1,"leftMaxOffset":22,"rightSign":1,"rightMaxOffset":19,"turnPercent":65}`
	put := httptest.NewRequest(http.MethodPut, "/api/motion-calibrations", strings.NewReader(body))
	putRecorder := httptest.NewRecorder()
	handler.ServeHTTP(putRecorder, put)
	if putRecorder.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", putRecorder.Code, putRecorder.Body.String())
	}
	get := httptest.NewRequest(http.MethodGet, "/api/motion-calibrations", nil)
	getRecorder := httptest.NewRecorder()
	handler.ServeHTTP(getRecorder, get)
	if getRecorder.Code != http.StatusOK || !strings.Contains(getRecorder.Body.String(), `"fish-2"`) || !strings.Contains(getRecorder.Body.String(), `"leftSign":-1`) {
		t.Fatalf("GET status=%d body=%s", getRecorder.Code, getRecorder.Body.String())
	}
}

func TestMotionCalibrationProfilesAcceptServoModel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "motion-calibrations.json")
	t.Setenv("FISH_MOTION_CALIBRATIONS", path)
	handler := NewHandler(hub.New(), testKey())
	body := `{"deviceId":"fish-2","servoMin":20,"servoMax":160,"straightCenter":96,"forwardFrequency":2.5,"forwardAmplitudePercent":0.45,"leftCenterRatio":0.5,"leftFrequency":2.3,"leftAmplitudePercent":0.55,"rightCenterRatio":0.5,"rightFrequency":2.3,"rightAmplitudePercent":0.55,"transitionMs":600}`
	put := httptest.NewRequest(http.MethodPut, "/api/motion-calibrations", strings.NewReader(body))
	putRecorder := httptest.NewRecorder()
	handler.ServeHTTP(putRecorder, put)
	if putRecorder.Code != http.StatusOK {
		t.Fatalf("PUT status=%d body=%s", putRecorder.Code, putRecorder.Body.String())
	}
	get := httptest.NewRequest(http.MethodGet, "/api/motion-calibrations", nil)
	getRecorder := httptest.NewRecorder()
	handler.ServeHTTP(getRecorder, get)
	if getRecorder.Code != http.StatusOK || !strings.Contains(getRecorder.Body.String(), `"straightCenter":96`) || !strings.Contains(getRecorder.Body.String(), `"transitionMs":600`) {
		t.Fatalf("GET status=%d body=%s", getRecorder.Code, getRecorder.Body.String())
	}
}

func TestDynamicChallengeRegistersDevice(t *testing.T) {
	key := make([]byte, 32)
	h := hub.New()
	testServer := httptest.NewServer(NewHandler(h, key))
	defer testServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/ws/device", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var challenge struct {
		Type, Nonce     string
		ProtocolVersion int
	}
	if err := conn.ReadJSON(&challenge); err != nil {
		t.Fatalf("读取挑战失败: %v", err)
	}
	proof, err := identity.Proof(key, "fish-websocket-v1", challenge.Nonce, "AC:27:6E:7C:37:18")
	if err != nil {
		t.Fatal(err)
	}
	err = conn.WriteJSON(map[string]any{"type": "register", "protocolVersion": 1, "deviceId": "AC:27:6E:7C:37:18", "proof": proof, "name": "测试鱼", "ip": "192.168.137.117", "firmwareVersion": "1.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := conn.ReadJSON(&result); err != nil || result["success"] != true {
		t.Fatalf("注册失败: %#v %v", result, err)
	}
	if devices := h.List(); len(devices) != 1 || !devices[0].Online {
		t.Fatalf("设备未进入在线列表: %+v", devices)
	}
}

func TestDashboardServesReactApplication(t *testing.T) {
	handler := NewHandler(hub.New(), testKey())
	r := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	body := w.Body.String()
	if !strings.Contains(body, `id="root"`) || !strings.Contains(body, `<script type="module"`) {
		t.Fatalf("首页没有提供 React 应用入口: %s", body)
	}
}

func TestMotionCommandIncludesBiasAndRequestID(t *testing.T) {
	h := hub.New()
	c := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		h.ResolveCommandResult(map[string]any{
			"type": "command.result", "requestId": message["requestId"], "success": true,
			"code": "OK", "message": "applied",
			"applied": map[string]any{"mode": 3.0, "frequency": 2.5, "amplitude": 28.0, "bias": -8.0},
		})
	}}
	h.Register(hub.Device{ID: "fish-1"}, c)
	handler := NewHandler(h, testKey())
	body := `{"deviceId":"fish-1","mode":"left","frequency":2.5,"amplitude":28,"bias":-8}`
	r := httptest.NewRequest("POST", "/api/command", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || len(c.sent) != 1 {
		t.Fatalf("命令发送失败: %d %s", w.Code, w.Body.String())
	}
	message := c.sent[0].(map[string]any)
	payload := message["payload"].(map[string]any)
	if payload["bias"] != -8.0 || message["requestId"] == "" {
		t.Fatalf("命令缺少偏置或请求 ID: %#v", message)
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response["requestId"] == "" || response["sent"] != true || response["acknowledged"] != true {
		t.Fatalf("响应缺少发送结果: %s", w.Body.String())
	}
}

func TestTurnCommandWithoutCalibrationUsesDefaultGeometry(t *testing.T) {
	h := hub.New()
	c := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		h.ResolveCommandResult(map[string]any{
			"type": "command.result", "requestId": message["requestId"], "success": true,
			"code": "OK", "message": "applied",
			"applied": map[string]any{"mode": 3.0, "frequency": 2.5, "amplitude": 28.0, "bias": 15.0},
		})
	}}
	h.Register(hub.Device{ID: "fish-1"}, c)
	handler := NewHandler(h, testKey())
	body := `{"deviceId":"fish-1","mode":"left","frequency":2.5,"amplitude":28}`
	r := httptest.NewRequest("POST", "/api/command", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || len(c.sent) != 1 {
		t.Fatalf("命令发送失败: %d %s", w.Code, w.Body.String())
	}
	payload := c.sent[0].(map[string]any)["payload"].(map[string]any)
	if payload["bias"] != -45.0 {
		t.Fatalf("未标定左转应使用新规则的默认偏置 -45°: %#v", payload)
	}
}

func TestMotionCommandUsesCalibratedTurnCenter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "motion-calibrations.json")
	t.Setenv("FISH_MOTION_CALIBRATIONS", path)
	if err := os.WriteFile(path, []byte(`{
		"fish-1": {
			"deviceId": "fish-1",
			"servoMin": 20,
			"servoMax": 160,
			"straightCenter": 90,
			"forwardFrequency": 2.5,
			"forwardAmplitudePercent": 0.45,
			"leftCenterRatio": 0.5,
			"leftFrequency": 2.3,
			"leftAmplitudePercent": 0.55,
			"rightCenterRatio": 0.5,
			"rightFrequency": 2.3,
			"rightAmplitudePercent": 0.55,
			"transitionMs": 600
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}

	h := hub.New()
	c := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		h.ResolveCommandResult(map[string]any{
			"type": "command.result", "requestId": message["requestId"], "success": true,
			"code": "OK", "message": "applied",
		})
	}}
	h.Register(hub.Device{ID: "fish-1"}, c)
	handler := NewHandler(h, testKey())
	body := `{"deviceId":"fish-1","mode":"left","frequency":2.5,"amplitude":50}`
	r := httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(body))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || len(c.sent) != 1 {
		t.Fatalf("命令发送失败: %d %s", w.Code, w.Body.String())
	}
	payload := c.sent[0].(map[string]any)["payload"].(map[string]any)
	if payload["bias"] != -35.0 || payload["amplitude"] != 35.0 {
		t.Fatalf("左转没有围绕标定中心摆动: %#v", payload)
	}
}

func TestAuthAndLeaseProtectMotionCommand(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	h := hub.New()
	c := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		h.ResolveCommandResult(map[string]any{
			"type": "command.result", "requestId": message["requestId"], "success": true,
			"code": "OK", "message": "applied",
		})
	}}
	h.Register(hub.Device{ID: "fish-1"}, c)
	handler := NewHandler(h, testKey())
	commandBody := `{"deviceId":"fish-1","mode":"left","frequency":2.5,"amplitude":28,"bias":-8}`
	unauth := httptest.NewRecorder()
	handler.ServeHTTP(unauth, httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(commandBody)))
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("未登录命令应被拒绝: %d %s", unauth.Code, unauth.Body.String())
	}

	register := httptest.NewRecorder()
	handler.ServeHTTP(register, httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{"name":"Admin","email":"admin@example.com","password":"password-123456"}`)))
	if register.Code != http.StatusOK {
		t.Fatalf("注册失败: %d %s", register.Code, register.Body.String())
	}
	cookie := register.Result().Cookies()[0]
	acquire := httptest.NewRecorder()
	acquireReq := httptest.NewRequest(http.MethodPost, "/api/leases", strings.NewReader(`{"deviceId":"fish-1","mode":"manual"}`))
	acquireReq.AddCookie(cookie)
	handler.ServeHTTP(acquire, acquireReq)
	if acquire.Code != http.StatusOK {
		t.Fatalf("获取控制权失败: %d %s", acquire.Code, acquire.Body.String())
	}

	authed := httptest.NewRecorder()
	commandReq := httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(commandBody))
	commandReq.AddCookie(cookie)
	handler.ServeHTTP(authed, commandReq)
	if authed.Code != http.StatusOK {
		t.Fatalf("已登录且持有控制权应可控制: %d %s", authed.Code, authed.Body.String())
	}
}
