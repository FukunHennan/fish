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

// 覆盖裁判端完整流程：建赛 -> 签到 -> 计时 -> 记分 -> 结束 -> 记录。
func TestCompetitionFlow(t *testing.T) {
	t.Setenv("FISH_COMPETITION_STATE", filepath.Join(t.TempDir(), "competition.json"))
	handler := NewHandler(hub.New(), testKey())

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

	// 2. 双方四名队员签到后应进入 ready
	for _, item := range []struct{ side, slot string }{
		{"blue", "B1"}, {"blue", "B2"}, {"red", "R1"}, {"red", "R2"},
	} {
		call(http.MethodPost, "/api/competition/match/signin",
			`{"side":"`+item.side+`","slot":"`+item.slot+`","signedIn":true,"deviceId":"dev-`+item.slot+`"}`)
	}
	final := call(http.MethodGet, "/api/competition/match", "")
	match = matchOf(final)
	if match["state"] != matchStateReady {
		t.Fatalf("全员签到后状态应为 ready，实际 %v", match["state"])
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
