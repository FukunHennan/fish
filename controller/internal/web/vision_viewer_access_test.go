package web

import (
	"fish-controller/internal/hub"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlayerCanOpenVisionVideoWithoutChangingSharedSettings(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	store := newAuthStore(authStorePath())
	if _, err := store.createUser("蓝队", "1", "1", "User"); err != nil {
		t.Fatal(err)
	}

	vision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/webrtc/offer" {
			_, _ = w.Write([]byte(`{"type":"answer","sdp":"test-answer"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer vision.Close()
	handler := NewHandlerWithVision(hub.New(), testKey(), vision.URL, vision.URL)

	request := func(method, path string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(`{"sessionId":"session-1","type":"offer","sdp":"test-offer"}`))
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}

	if got := request(http.MethodPost, "/api/vision/webrtc/offer", nil).Code; got != http.StatusUnauthorized {
		t.Fatalf("未登录的 WebRTC 请求状态 = %d", got)
	}
	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"email":"1","password":"1"}`)))
	if login.Code != http.StatusOK || len(login.Result().Cookies()) == 0 {
		t.Fatalf("选手登录失败: %d %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	for _, path := range []string{"/api/vision/sessions/current", "/api/vision/webrtc/config"} {
		if got := request(http.MethodGet, path, cookie).Code; got != http.StatusOK {
			t.Fatalf("选手读取 %s 状态 = %d", path, got)
		}
	}
	offer := request(http.MethodPost, "/api/vision/webrtc/offer", cookie)
	if offer.Code != http.StatusOK || !strings.Contains(offer.Body.String(), `"test-answer"`) {
		t.Fatalf("选手 WebRTC 信令失败: %d %s", offer.Code, offer.Body.String())
	}
	for _, path := range []string{"/api/vision/sessions", "/api/vision/action", "/api/vision/webrtc/offer/extra"} {
		if got := request(http.MethodPost, path, cookie).Code; got != http.StatusForbidden {
			t.Fatalf("选手修改共享视觉设置 %s 状态 = %d", path, got)
		}
	}
}
