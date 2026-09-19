package web

import (
	"encoding/json"
	"fish-controller/internal/hub"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestDevelopmentMatchSeedsFourSignedInAccountsAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "competition.json")
	store := newCompetitionStore(path)
	store.ensureDevelopmentMatch()
	if store.Match == nil || store.Match.State != matchStateReady {
		t.Fatalf("开发比赛应默认就绪: %+v", store.Match)
	}
	if !store.Match.Blue.allSignedIn() || !store.Match.Red.allSignedIn() {
		t.Fatalf("开发模式四名选手应默认登录: %+v", store.Match)
	}
	if store.Match.Blue.Players[0].Email != "stu-24018@fish.local" || store.Match.Red.Players[1].Name != "赵同学" {
		t.Fatalf("开发账号名单异常: %+v", store.Match)
	}
	reloaded := newCompetitionStore(path)
	if reloaded.Match == nil || !reloaded.Match.Blue.Players[0].SignedIn {
		t.Fatalf("开发比赛应写入磁盘并可恢复: %+v", reloaded.Match)
	}
}

// 覆盖裁判端完整流程：建赛 -> 签到 -> 计时 -> 记分 -> 结束 -> 记录。
func TestCompetitionFlow(t *testing.T) {
	t.Setenv("FISH_COMPETITION_STATE", filepath.Join(t.TempDir(), "competition.json"))
	recordingCalls := []string{}
	vision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recordingCalls = append(recordingCalls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/recordings":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			_ = json.NewEncoder(w).Encode(map[string]any{"recording": map[string]any{
				"active": true, "recordingId": body["recordingId"],
				"startedAt": "2026-09-17T10:00:00-04:00", "width": 712, "height": 410,
			}})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/recordings/"):
			_ = json.NewEncoder(w).Encode(map[string]any{"recording": map[string]any{
				"active": false, "recordingId": strings.TrimPrefix(r.URL.Path, "/recordings/"),
				"fileName": "match-test.mp4", "durationMs": 1200, "frameCount": 18,
				"averageFps": 15.0, "width": 712, "height": 410,
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(vision.Close)
	handler := NewHandlerWithVision(hub.New(), testKey(), vision.URL, vision.URL)

	call := func(method, path, body string) map[string]any {
		t.Helper()
		var reader *strings.Reader
		if body == "" {
			reader = strings.NewReader("")
		} else {
			reader = strings.NewReader(body)
		}
		request := httptest.NewRequest(method, path, reader)
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s %s -> %d %s", method, path, recorder.Code, recorder.Body.String())
		}
		var payload map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("%s %s 响应不是 JSON: %s", method, path, recorder.Body.String())
		}
		return payload
	}

	matchOf := func(payload map[string]any) map[string]any {
		t.Helper()
		match, ok := payload["match"].(map[string]any)
		if !ok {
			t.Fatalf("响应缺少 match: %+v", payload)
		}
		return match
	}

	// 1. 建立比赛
	created := call(http.MethodPut, "/api/competition/match",
		`{"matchNo":"第 08 场","group":"学生组","venue":"A 赛场","blue":{"name":"海洋先锋队"},"red":{"name":"深海动力队"}}`)
	match := matchOf(created)
	if match["matchNo"] != "第 08 场" || match["state"] != matchStateSignup {
		t.Fatalf("建赛结果异常: %+v", match)
	}

	// 场地实际尺寸由裁判填写并随比赛持久化，供画面标尺使用。
	field := call(http.MethodPost, "/api/competition/match/field",
		`{"fieldWidthCm":314.2,"fieldHeightCm":160}`)
	match = matchOf(field)
	if match["fieldWidthCm"].(float64) != 314.2 || match["fieldHeightCm"].(float64) != 160 {
		t.Fatalf("场地尺寸保存异常: %+v", match)
	}
	locked := call(http.MethodPost, "/api/competition/match/field-lock",
		`{"fieldLocked":true}`)
	match = matchOf(locked)
	if match["fieldLocked"] != true {
		t.Fatalf("场地锁定状态未持久化: %+v", match)
	}

	// 2. 双方四名队员签到后应进入 ready
	for _, item := range []struct{ side, slot string }{
		{"blue", "B1"}, {"blue", "B2"}, {"red", "R1"}, {"red", "R2"},
	} {
		call(http.MethodPost, "/api/competition/match/signin",
			`{"side":"`+item.side+`","slot":"`+item.slot+`","name":"account-`+item.slot+`","email":"account-`+item.slot+`@example.com","signedIn":true,"deviceId":"dev-`+item.slot+`"}`)
	}
	final := call(http.MethodGet, "/api/competition/match", "")
	match = matchOf(final)
	if match["state"] != matchStateReady {
		t.Fatalf("全员签到后状态应为 ready，实际 %v", match["state"])
	}
	bluePlayers := match["blue"].(map[string]any)["players"].([]any)
	if bluePlayers[0].(map[string]any)["email"] != "account-B1@example.com" {
		t.Fatalf("比赛快照应保留真实账号邮箱: %+v", bluePlayers[0])
	}

	// 3. 计时
	started := call(http.MethodPost, "/api/competition/match/clock", `{"action":"start"}`)
	if started["running"] != true {
		t.Fatalf("start 后应处于计时中: %+v", started)
	}
	if matchOf(started)["state"] != matchStateRunning {
		t.Fatalf("start 后状态应为 running")
	}
	paused := call(http.MethodPost, "/api/competition/match/clock", `{"action":"pause"}`)
	if paused["running"] != false {
		t.Fatalf("pause 后应停止计时: %+v", paused)
	}

	// 4. 记分
	call(http.MethodPost, "/api/competition/match/score", `{"side":"blue","delta":3}`)
	scored := call(http.MethodPost, "/api/competition/match/score", `{"side":"red","score":2}`)
	match = matchOf(scored)
	blue := match["blue"].(map[string]any)
	red := match["red"].(map[string]any)
	if blue["score"].(float64) != 3 || red["score"].(float64) != 2 {
		t.Fatalf("比分异常: blue=%v red=%v", blue["score"], red["score"])
	}

	// 5. 结束并写入记录
	call(http.MethodPost, "/api/competition/match/finish", "")
	records := call(http.MethodGet, "/api/competition/records", "")
	list, ok := records["records"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("比赛记录应为 1 条: %+v", records)
	}
	entry := list[0].(map[string]any)
	if entry["blueName"] != "海洋先锋队" || entry["blueScore"].(float64) != 3 {
		t.Fatalf("记录内容异常: %+v", entry)
	}
	if entry["videoUrl"] != "/api/vision/recordings/files/match-test.mp4" || entry["videoStatus"] != "saved" {
		t.Fatalf("比赛记录应包含可回放录像: %+v", entry)
	}
	if len(recordingCalls) != 2 || recordingCalls[0] != "POST /recordings" || !strings.HasPrefix(recordingCalls[1], "DELETE /recordings/") {
		t.Fatalf("比赛开始和结束应自动启停录像: %+v", recordingCalls)
	}
}

func TestCompetitionDoesNotStartWhenRecordingCannotStart(t *testing.T) {
	t.Setenv("FISH_COMPETITION_STATE", filepath.Join(t.TempDir(), "competition.json"))
	vision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"当前没有可录制的选手视频帧"}`))
	}))
	t.Cleanup(vision.Close)
	handler := NewHandlerWithVision(hub.New(), testKey(), vision.URL, vision.URL)

	created := httptest.NewRecorder()
	handler.ServeHTTP(created, httptest.NewRequest(
		http.MethodPut,
		"/api/competition/match",
		strings.NewReader(`{"matchNo":"第 02 场"}`),
	))
	started := httptest.NewRecorder()
	handler.ServeHTTP(started, httptest.NewRequest(
		http.MethodPost,
		"/api/competition/match/clock",
		strings.NewReader(`{"action":"start"}`),
	))
	if started.Code != http.StatusBadGateway {
		t.Fatalf("录像未启动时比赛不应开始，实际 %d %s", started.Code, started.Body.String())
	}
	current := httptest.NewRecorder()
	handler.ServeHTTP(current, httptest.NewRequest(http.MethodGet, "/api/competition/match", nil))
	var payload map[string]any
	_ = json.Unmarshal(current.Body.Bytes(), &payload)
	if payload["running"] != false {
		t.Fatalf("录像失败后计时器不应运行: %+v", payload)
	}
}

// 未登录且开启认证时，裁判接口必须拒绝。
func TestCompetitionRequiresUser(t *testing.T) {
	t.Setenv("FISH_COMPETITION_STATE", filepath.Join(t.TempDir(), "competition.json"))
	t.Setenv("FISH_AUTH_DISABLED", "false")
	handler := NewHandler(hub.New(), testKey())

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/competition/match", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("未登录应返回 401，实际 %d", recorder.Code)
	}
}

type assignmentTestConn struct{}

func (assignmentTestConn) WriteJSON(any) error { return nil }
func (assignmentTestConn) Close() error        { return nil }

func TestCompetitionPlayerReadinessUsesAssignedOnlineDevice(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "competition.json")
	t.Setenv("FISH_COMPETITION_STATE", statePath)
	h := hub.New()
	conn := assignmentTestConn{}
	h.Register(hub.Device{ID: "fish-ready", Name: "准备测试鱼", Online: true}, conn)
	handler := NewHandler(h, testKey())

	call := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		var payload map[string]any
		_ = json.Unmarshal(recorder.Body.Bytes(), &payload)
		return recorder.Code, payload
	}
	player := func(payload map[string]any) map[string]any {
		t.Helper()
		match := payload["match"].(map[string]any)
		blue := match["blue"].(map[string]any)
		return blue["players"].([]any)[0].(map[string]any)
	}

	if code, _ := call(http.MethodPut, "/api/competition/match", `{"matchNo":"准备状态测试"}`); code != http.StatusOK {
		t.Fatalf("建赛失败: %d", code)
	}
	if code, _ := call(http.MethodPost, "/api/competition/match/assign", `{"side":"blue","slot":"B1","deviceId":"fish-ready"}`); code != http.StatusOK {
		t.Fatalf("分配在线设备失败: %d", code)
	}
	code, ready := call(http.MethodPost, "/api/competition/match/ready", `{"side":"blue","slot":"B1","deviceId":"fish-ready","ready":true}`)
	if code != http.StatusOK || player(ready)["ready"] != true || player(ready)["readyDeviceId"] != "fish-ready" {
		t.Fatalf("选手准备状态未保存: %d %+v", code, ready)
	}

	reloaded := newCompetitionStore(statePath)
	if reloaded.Match == nil || !reloaded.Match.Blue.Players[0].Ready {
		t.Fatalf("准备状态应持久化: %+v", reloaded.Match)
	}

	h.Remove("fish-ready", conn)
	code, offline := call(http.MethodGet, "/api/competition/match", "")
	if code != http.StatusOK || player(offline)["ready"] != false {
		t.Fatalf("设备掉线后准备状态应自动失效: %d %+v", code, offline)
	}

	code, rejected := call(http.MethodPost, "/api/competition/match/ready", `{"side":"blue","slot":"B1","deviceId":"fish-ready","ready":true}`)
	if code != http.StatusConflict {
		t.Fatalf("离线设备不应允许提交准备: %d %+v", code, rejected)
	}
}

func TestCompetitionVisionTrackBindingPersistsAndSwaps(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "competition.json")
	t.Setenv("FISH_COMPETITION_STATE", statePath)
	handler := NewHandler(hub.New(), testKey())

	call := func(path, body string) (int, map[string]any) {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		var payload map[string]any
		_ = json.Unmarshal(recorder.Body.Bytes(), &payload)
		return recorder.Code, payload
	}
	trackFor := func(payload map[string]any, slot string) any {
		t.Helper()
		match := payload["match"].(map[string]any)
		players := match["blue"].(map[string]any)["players"].([]any)
		for _, raw := range players {
			player := raw.(map[string]any)
			if player["slot"] == slot {
				return player["visionTrackId"]
			}
		}
		return nil
	}

	if code, _ := call("/api/competition/match", `{"matchNo":"视觉绑定测试"}`); code != http.StatusOK {
		t.Fatalf("建赛失败: %d", code)
	}
	code, first := call("/api/competition/match/vision-bind", `{"side":"blue","slot":"B1","targetTrackId":7}`)
	if code != http.StatusOK || trackFor(first, "B1") != float64(7) {
		t.Fatalf("B1 视觉绑定失败: %d %+v", code, first)
	}
	_, second := call("/api/competition/match/vision-bind", `{"side":"blue","slot":"B2","targetTrackId":9}`)
	_, swapped := call("/api/competition/match/vision-bind", `{"side":"blue","slot":"B1","targetTrackId":9}`)
	if trackFor(swapped, "B1") != float64(9) || trackFor(swapped, "B2") != float64(7) {
		t.Fatalf("重复 Track 应交换席位绑定: %+v", swapped)
	}
	if code, _ := call("/api/competition/match/vision-bind", `{"side":"red","slot":"R1","targetTrackId":9}`); code != http.StatusConflict {
		t.Fatalf("对方队伍不应抢占已绑定 Track，实际 %d", code)
	}

	reloaded := newCompetitionStore(statePath)
	if reloaded.Match == nil || reloaded.Match.Blue.Players[0].VisionTrackID == nil || *reloaded.Match.Blue.Players[0].VisionTrackID != 9 {
		t.Fatalf("视觉绑定应持久化: %+v", reloaded.Match)
	}
	code, unbound := call("/api/competition/match/vision-unbind", `{"side":"blue","slot":"B1"}`)
	if code != http.StatusOK || trackFor(unbound, "B1") != nil || trackFor(second, "B2") != float64(9) {
		t.Fatalf("解除视觉绑定失败: %d %+v", code, unbound)
	}
}

// 覆盖签到环节的机器鱼绑定与归属：列表、分配、冲突、离线、解除。
func TestCompetitionDeviceAssignment(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "competition.json")
	t.Setenv("FISH_COMPETITION_STATE", statePath)
	h := hub.New()
	handler := NewHandler(h, testKey())
	h.Register(hub.Device{ID: "fish-a", Name: "机器鱼A", Online: true, IP: "192.168.1.10", RSSI: -42, BatteryPercent: 86}, assignmentTestConn{})
	h.Register(hub.Device{ID: "fish-b", Name: "机器鱼B", Online: true}, assignmentTestConn{})

	call := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		var payload map[string]any
		_ = json.Unmarshal(recorder.Body.Bytes(), &payload)
		return recorder.Code, payload
	}
	playerDevice := func(payload map[string]any, side, slot string) string {
		t.Helper()
		match := payload["match"].(map[string]any)
		team := match[side].(map[string]any)
		for _, raw := range team["players"].([]any) {
			player := raw.(map[string]any)
			if player["slot"] == slot {
				if value, ok := player["deviceId"].(string); ok {
					return value
				}
				return ""
			}
		}
		return ""
	}

	// 建赛
	if code, _ := call(http.MethodPut, "/api/competition/match", `{"matchNo":"第 01 场"}`); code != http.StatusOK {
		t.Fatalf("建赛失败: %d", code)
	}

	// 设备列表：两台均未分配
	code, listed := call(http.MethodGet, "/api/competition/devices", "")
	if code != http.StatusOK {
		t.Fatalf("设备列表失败: %d", code)
	}
	devices := listed["devices"].([]any)
	if len(devices) != 2 {
		t.Fatalf("应返回 2 台设备: %+v", devices)
	}
	for _, raw := range devices {
		if _, taken := raw.(map[string]any)["assignedTo"]; taken {
			t.Fatalf("初始不应有归属: %+v", raw)
		}
	}
	for _, raw := range devices {
		item := raw.(map[string]any)
		if item["deviceId"] == "fish-a" && (item["ip"] != "192.168.1.10" || item["batteryPercent"].(float64) != 86) {
			t.Fatalf("设备列表应返回真实状态字段: %+v", item)
		}
	}

	// 分配 fish-a 给蓝队 B1
	code, assigned := call(http.MethodPost, "/api/competition/match/assign",
		`{"side":"blue","slot":"B1","deviceId":"fish-a"}`)
	if code != http.StatusOK {
		t.Fatalf("分配失败: %d %+v", code, assigned)
	}
	if got := playerDevice(assigned, "blue", "B1"); got != "fish-a" {
		t.Fatalf("B1 应绑定 fish-a，实际 %q", got)
	}

	// 同一台鱼可以直接换绑到另一个席位，旧席位必须自动释放
	code, reassigned := call(http.MethodPost, "/api/competition/match/assign",
		`{"side":"red","slot":"R1","deviceId":"fish-a"}`)
	if code != http.StatusOK {
		t.Fatalf("换绑失败: %d %+v", code, reassigned)
	}
	if got := playerDevice(reassigned, "blue", "B1"); got != "" {
		t.Fatalf("换绑后旧席位应释放，实际 %q", got)
	}
	if got := playerDevice(reassigned, "red", "R1"); got != "fish-a" {
		t.Fatalf("换绑后 R1 应绑定 fish-a，实际 %q", got)
	}

	// 离线设备不能被分配
	if code, _ := call(http.MethodPost, "/api/competition/match/assign",
		`{"side":"red","slot":"R1","deviceId":"fish-ghost"}`); code != http.StatusConflict {
		t.Fatalf("离线设备应返回 409，实际 %d", code)
	}

	// 分配后设备列表反映新归属
	_, listed = call(http.MethodGet, "/api/competition/devices", "")
	for _, raw := range listed["devices"].([]any) {
		item := raw.(map[string]any)
		if item["deviceId"] == "fish-a" && item["assignedTo"] != "red/R1" {
			t.Fatalf("fish-a 归属应为 red/R1: %+v", item)
		}
	}

	// 解除归属后可重新分配
	if code, released := call(http.MethodPost, "/api/competition/match/unassign",
		`{"side":"blue","slot":"B1"}`); code != http.StatusOK {
		t.Fatalf("解除失败: %d", code)
	} else if got := playerDevice(released, "blue", "B1"); got != "" {
		t.Fatalf("解除后应为空，实际 %q", got)
	}
	if code, released := call(http.MethodPost, "/api/competition/match/unassign",
		`{"side":"red","slot":"R1"}`); code != http.StatusOK {
		t.Fatalf("解除失败: %d", code)
	} else if got := playerDevice(released, "red", "R1"); got != "" {
		t.Fatalf("解除后 R1 应为空，实际 %q", got)
	}
	if code, _ := call(http.MethodPost, "/api/competition/match/assign",
		`{"side":"blue","slot":"B2","deviceId":"fish-a"}`); code != http.StatusOK {
		t.Fatalf("重新分配失败: %d", code)
	}

	// 控制器重启后、设备尚未重新连接时，席位归属仍应作为离线设备返回。
	reloaded := newCompetitionStore(statePath)
	offline := (&server{hub: hub.New()}).competitionDevicesLocked(reloaded)["devices"].([]map[string]any)
	if len(offline) != 1 || offline[0]["deviceId"] != "fish-a" || offline[0]["assignedTo"] != "blue/B2" || offline[0]["online"] != false {
		t.Fatalf("重启后应保留离线设备归属: %+v", offline)
	}
}
