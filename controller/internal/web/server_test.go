package web

import (
	"bufio"
	"context"
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
	h.Register(hub.Device{ID: "fish-1", Name: "机器鱼1号"}, connection)
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
	if payload["name"] != "机器鱼1号" {
		t.Fatalf("OTA 未携带设备名称: %#v", payload)
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

func TestAuthIsDisabledByDefaultForLocalCommissioning(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "")
	handler := NewHandler(hub.New(), testKey())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))
	var response map[string]any
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil || response["authenticated"] != true {
		t.Fatalf("本地调试默认应跳过登录: %d %s", w.Code, w.Body.String())
	}
	if response["user"] == nil {
		t.Fatalf("免登录模式应提供本地管理员身份: %s", w.Body.String())
	}
}

func TestDeviceEventsPushInitialSnapshotAndUpdates(t *testing.T) {
	h := hub.New()
	testServer := httptest.NewServer(NewHandler(h, testKey()))
	defer testServer.Close()

	request, err := http.NewRequest(http.MethodGet, testServer.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request = request.WithContext(ctx)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("事件流响应异常: %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "event: devices\n" {
		t.Fatalf("没有收到初始设备事件: %q %v", line, err)
	}
	line, err = reader.ReadString('\n')
	if err != nil || line != "data: []\n" {
		t.Fatalf("初始设备快照异常: %q %v", line, err)
	}
	if _, err := reader.ReadString('\n'); err != nil {
		t.Fatalf("初始事件没有结束: %v", err)
	}

	h.Register(hub.Device{ID: "fish-1", Name: "测试鱼"}, &captureConn{})
	for {
		line, err = reader.ReadString('\n')
		if err != nil {
			t.Fatalf("设备上线后没有收到事件: %v", err)
		}
		if strings.HasPrefix(line, "data: ") {
			if !strings.Contains(line, `"deviceId":"fish-1"`) {
				t.Fatalf("设备事件没有包含目标鱼: %q", line)
			}
			return
		}
	}
}

func TestAdminBootstrapAndUserManagement(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	t.Setenv("FISH_INVITE_CODE", "")
	handler := NewHandler(hub.New(), testKey())

	bootstrapRecorder := httptest.NewRecorder()
	handler.ServeHTTP(bootstrapRecorder, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))
	var bootstrap map[string]any
	if json.Unmarshal(bootstrapRecorder.Body.Bytes(), &bootstrap) != nil || bootstrap["bootstrap"] != true {
		t.Fatalf("空用户库应进入管理员初始化: %s", bootstrapRecorder.Body.String())
	}

	register := httptest.NewRecorder()
	handler.ServeHTTP(register, httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(
		`{"name":"管理员","email":"admin@example.com","password":"admin-pass-123"}`,
	)))
	if register.Code != http.StatusOK || len(register.Result().Cookies()) == 0 {
		t.Fatalf("初始化管理员失败: %d %s", register.Code, register.Body.String())
	}
	var registered map[string]any
	if json.Unmarshal(register.Body.Bytes(), &registered) != nil || registered["authenticated"] != true {
		t.Fatalf("初始化管理员未自动登录: %s", register.Body.String())
	}
	adminCookie := register.Result().Cookies()[0]

	publicRegister := httptest.NewRecorder()
	handler.ServeHTTP(publicRegister, httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(
		`{"name":"访客","email":"visitor@example.com","password":"visitor-pass-123"}`,
	)))
	if publicRegister.Code != http.StatusForbidden {
		t.Fatalf("已有管理员后公开注册应被拒绝: %d %s", publicRegister.Code, publicRegister.Body.String())
	}

	create := httptest.NewRequest(http.MethodPost, "/api/auth/users", strings.NewReader(
		`{"name":"操作员","email":"operator@example.com","password":"operator-pass-123","role":"Operator"}`,
	))
	create.AddCookie(adminCookie)
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, create)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), `"created":true`) {
		t.Fatalf("管理员创建账户失败: %d %s", created.Code, created.Body.String())
	}
	if strings.Contains(created.Body.String(), "passwordHash") || strings.Contains(created.Body.String(), "passwordSalt") {
		t.Fatalf("创建账户响应泄露密码资料: %s", created.Body.String())
	}
	var createdPublic struct {
		User map[string]any `json:"user"`
	}
	if json.Unmarshal(created.Body.Bytes(), &createdPublic) != nil || createdPublic.User["role"] != "User" || createdPublic.User["roleLabel"] != "普通用户" {
		t.Fatalf("历史 Operator 应统一为普通用户: %s", created.Body.String())
	}

	loginOperator := httptest.NewRecorder()
	handler.ServeHTTP(loginOperator, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(
		`{"email":"operator@example.com","password":"operator-pass-123"}`,
	)))
	if loginOperator.Code != http.StatusOK || len(loginOperator.Result().Cookies()) == 0 {
		t.Fatalf("管理员创建的操作员无法登录: %d %s", loginOperator.Code, loginOperator.Body.String())
	}
	operatorCookie := loginOperator.Result().Cookies()[0]

	operatorUsers := httptest.NewRequest(http.MethodGet, "/api/auth/users", nil)
	operatorUsers.AddCookie(operatorCookie)
	operatorUsersRecorder := httptest.NewRecorder()
	handler.ServeHTTP(operatorUsersRecorder, operatorUsers)
	if operatorUsersRecorder.Code != http.StatusForbidden {
		t.Fatalf("普通操作员不应访问账户管理: %d %s", operatorUsersRecorder.Code, operatorUsersRecorder.Body.String())
	}

	patchOperator := httptest.NewRequest(http.MethodPatch, "/api/auth/users", strings.NewReader(
		`{"id":"missing","status":"disabled"}`,
	))
	patchOperator.AddCookie(operatorCookie)
	patchOperatorRecorder := httptest.NewRecorder()
	handler.ServeHTTP(patchOperatorRecorder, patchOperator)
	if patchOperatorRecorder.Code != http.StatusForbidden {
		t.Fatalf("普通操作员不应修改账户: %d %s", patchOperatorRecorder.Code, patchOperatorRecorder.Body.String())
	}

	var createdEnvelope struct {
		User map[string]any `json:"user"`
	}
	if json.Unmarshal(created.Body.Bytes(), &createdEnvelope) != nil || createdEnvelope.User["id"] == nil {
		t.Fatalf("创建响应缺少账户 ID: %s", created.Body.String())
	}
	operatorID := createdEnvelope.User["id"].(string)
	disable := httptest.NewRequest(http.MethodPatch, "/api/auth/users", strings.NewReader(
		fmt.Sprintf(`{"id":%q,"status":"disabled"}`, operatorID),
	))
	disable.AddCookie(adminCookie)
	disableRecorder := httptest.NewRecorder()
	handler.ServeHTTP(disableRecorder, disable)
	if disableRecorder.Code != http.StatusOK {
		t.Fatalf("管理员停用账户失败: %d %s", disableRecorder.Code, disableRecorder.Body.String())
	}

	disabledLogin := httptest.NewRecorder()
	handler.ServeHTTP(disabledLogin, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(
		`{"email":"operator@example.com","password":"operator-pass-123"}`,
	)))
	if disabledLogin.Code != http.StatusUnauthorized {
		t.Fatalf("停用账户仍可登录: %d %s", disabledLogin.Code, disabledLogin.Body.String())
	}

	selfDelete := httptest.NewRequest(http.MethodDelete, "/api/auth/users", strings.NewReader(
		`{"id":"`+registered["user"].(map[string]any)["id"].(string)+`"}`,
	))
	selfDelete.AddCookie(adminCookie)
	selfDeleteRecorder := httptest.NewRecorder()
	handler.ServeHTTP(selfDeleteRecorder, selfDelete)
	if selfDeleteRecorder.Code != http.StatusConflict {
		t.Fatalf("管理员不应删除自己: %d %s", selfDeleteRecorder.Code, selfDeleteRecorder.Body.String())
	}

	selfDemote := httptest.NewRequest(http.MethodPatch, "/api/auth/users", strings.NewReader(
		`{"id":"`+registered["user"].(map[string]any)["id"].(string)+`","role":"Viewer"}`,
	))
	selfDemote.AddCookie(adminCookie)
	selfDemoteRecorder := httptest.NewRecorder()
	handler.ServeHTTP(selfDemoteRecorder, selfDemote)
	if selfDemoteRecorder.Code != http.StatusConflict {
		t.Fatalf("管理员不应降权自己: %d %s", selfDemoteRecorder.Code, selfDemoteRecorder.Body.String())
	}
}

func TestUserCannotAccessAdminOnlyEndpoints(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	t.Setenv("FISH_MOTION_CALIBRATIONS", filepath.Join(t.TempDir(), "motion-calibrations.json"))
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

	register := httptest.NewRecorder()
	handler.ServeHTTP(register, httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(
		`{"name":"管理员","email":"admin@example.com","password":"admin-pass-123"}`,
	)))
	if register.Code != http.StatusOK || len(register.Result().Cookies()) == 0 {
		t.Fatalf("初始化管理员失败: %d %s", register.Code, register.Body.String())
	}
	adminCookie := register.Result().Cookies()[0]

	create := httptest.NewRequest(http.MethodPost, "/api/auth/users", strings.NewReader(
		`{"name":"普通用户","email":"user@example.com","password":"user-pass-123","role":"User"}`,
	))
	create.AddCookie(adminCookie)
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, create)
	if created.Code != http.StatusOK {
		t.Fatalf("创建普通用户失败: %d %s", created.Code, created.Body.String())
	}

	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(
		`{"email":"user@example.com","password":"user-pass-123"}`,
	)))
	if login.Code != http.StatusOK || len(login.Result().Cookies()) == 0 {
		t.Fatalf("普通用户登录失败: %d %s", login.Code, login.Body.String())
	}
	userCookie := login.Result().Cookies()[0]

	adminOnly := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/auth/users", ""},
		{http.MethodGet, "/api/firmware", ""},
		{http.MethodGet, "/api/firmware/current.bin", ""},
		{http.MethodPost, "/api/ota", `{}`},
		{http.MethodPost, "/api/emergency-stop", `{}`},
	}
	for _, endpoint := range adminOnly {
		t.Run(endpoint.method+" "+endpoint.path, func(t *testing.T) {
			request := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(endpoint.body))
			request.AddCookie(userCookie)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("普通用户不应访问管理员接口: %d %s", response.Code, response.Body.String())
			}
		})
	}

	calibration := httptest.NewRequest(http.MethodPut, "/api/motion-calibrations", strings.NewReader(
		`{"deviceId":"fish-1","centerDeg":94,"frequency":2.4,"amplitude":26,"leftSign":-1,"leftMaxOffset":22,"rightSign":1,"rightMaxOffset":19,"turnPercent":65}`,
	))
	calibration.AddCookie(userCookie)
	calibrationResponse := httptest.NewRecorder()
	handler.ServeHTTP(calibrationResponse, calibration)
	if calibrationResponse.Code != http.StatusOK {
		t.Fatalf("普通用户应能保存舵机标定: %d %s", calibrationResponse.Code, calibrationResponse.Body.String())
	}

	rgb := httptest.NewRequest(http.MethodPost, "/api/rgb", strings.NewReader(
		`{"deviceId":"fish-1","mode":"SOLID","order":"GRB","red":0,"green":255,"blue":80,"brightness":32}`,
	))
	rgb.AddCookie(userCookie)
	rgbResponse := httptest.NewRecorder()
	handler.ServeHTTP(rgbResponse, rgb)
	if rgbResponse.Code != http.StatusOK {
		t.Fatalf("普通用户应能设置 RGB: %d %s", rgbResponse.Code, rgbResponse.Body.String())
	}

	devices := httptest.NewRecorder()
	deviceRequest := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	deviceRequest.AddCookie(userCookie)
	handler.ServeHTTP(devices, deviceRequest)
	if devices.Code != http.StatusOK {
		t.Fatalf("普通用户应能读取设备状态: %d %s", devices.Code, devices.Body.String())
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
	body := `{"operation":"motion","sessionId":"session-1","mode":"forward","frequency":2.8,"amplitude":31,"bias":-12}`
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
	if message["command"] != "motion.set" {
		t.Fatalf("命令=%v", message["command"])
	}
	payload := message["payload"].(map[string]any)
	if payload["mode"] != "forward" || payload["frequency"] != 2.8 || payload["amplitude"] != 31.0 || payload["bias"] != -12.0 {
		t.Fatalf("载荷=%+v", payload)
	}
}

func TestVisionDeviceCommandNormalizesOutOfRangeMotion(t *testing.T) {
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
	request := httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(
		`{"operation":"motion","deviceId":"fish-1","sessionId":"session-1","mode":"left","frequency":8,"amplitude":100,"bias":120}`,
	))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("视觉超范围参数不应整帧失败: %d %s", response.Code, response.Body.String())
	}
	message := connection.sent[0].(map[string]any)
	payload := message["payload"].(map[string]any)
	if payload["frequency"] != 5.0 || payload["amplitude"] != 45.0 || payload["bias"] != 90.0 {
		t.Fatalf("视觉参数没有被控制器归一化: %#v", payload)
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
	message := second.sent[0].(map[string]any)
	if message["command"] != "motion.set" {
		t.Fatalf("command=%v", message["command"])
	}
	payload := message["payload"].(map[string]any)
	if payload["mode"] != "forward" || payload["frequency"] != 2.0 || payload["amplitude"] != 22.0 {
		t.Fatalf("payload=%+v", payload)
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

func TestMotionCommandSupportsStopAndIdleModes(t *testing.T) {
	for _, mode := range []string{"stop", "idle"} {
		t.Run(mode, func(t *testing.T) {
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
			body := fmt.Sprintf(`{"deviceId":"fish-1","mode":"%s","frequency":2.5,"amplitudePercent":40}`, mode)
			r := httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(body))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusOK || len(c.sent) != 1 {
				t.Fatalf("%s 命令发送失败: %d %s", mode, w.Code, w.Body.String())
			}
			message := c.sent[0].(map[string]any)
			payload := message["payload"].(map[string]any)
			if payload["mode"] != mode {
				t.Fatalf("模式没有原样转发: got=%v want=%s", payload["mode"], mode)
			}
			if mode == "stop" && payload["amplitude"] != 0.0 {
				t.Fatalf("停止命令不应携带运动幅度: got=%v", payload["amplitude"])
			}
			if mode == "stop" && payload["bias"] != 0.0 {
				t.Fatalf("停止命令必须回到直线中位: got=%v", payload["bias"])
			}
		})
	}
}

func TestRealtimeCommandDropsOutOfOrderKeyboardFrame(t *testing.T) {
	h := hub.New()
	c := &captureConn{}
	h.Register(hub.Device{ID: "fish-1"}, c)
	handler := NewHandler(h, testKey())

	post := func(sequence uint64, mode string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"deviceId":"fish-1","mode":"%s","frequency":2.5,"amplitudePercent":40,"sequence":%d}`, mode, sequence)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/command/realtime", strings.NewReader(body)))
		return w
	}
	if post(2, "stop").Code != http.StatusOK {
		t.Fatal("最新停止命令没有入队")
	}
	if post(1, "forward").Code != http.StatusConflict {
		t.Fatal("过期的前进命令不应覆盖停止命令")
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

func TestMotionCommandBalancesTurnCentersAroundAsymmetricStraightCenter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "motion-calibrations.json")
	t.Setenv("FISH_MOTION_CALIBRATIONS", path)
	if err := os.WriteFile(path, []byte(`{
		"fish-1": {
			"deviceId": "fish-1",
			"servoMin": 0,
			"servoMax": 180,
			"straightCenter": 100,
			"forwardFrequency": 2.5,
			"forwardAmplitudePercent": 0.4,
			"leftCenterRatio": 1,
			"leftFrequency": 2.3,
			"leftAmplitudePercent": 0.4,
			"rightCenterRatio": 1,
			"rightFrequency": 2.3,
			"rightAmplitudePercent": 0.4,
			"transitionMs": 600
		}
	}`), 0600); err != nil {
		t.Fatal(err)
	}

	for _, testCase := range []struct {
		mode string
		bias float64
	}{
		{mode: "left", bias: -40},
		{mode: "right", bias: 40},
	} {
		t.Run(testCase.mode, func(t *testing.T) {
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
			body := fmt.Sprintf(`{"deviceId":"fish-1","mode":"%s","frequency":2.5,"amplitudePercent":40}`, testCase.mode)
			r := httptest.NewRequest(http.MethodPost, "/api/command", strings.NewReader(body))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusOK || len(c.sent) != 1 {
				t.Fatalf("%s 命令发送失败: %d %s", testCase.mode, w.Code, w.Body.String())
			}
			payload := c.sent[0].(map[string]any)["payload"].(map[string]any)
			if payload["bias"] != testCase.bias {
				t.Fatalf("%s 中心偏置错误: got=%v want=%v", testCase.mode, payload["bias"], testCase.bias)
			}
		})
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
