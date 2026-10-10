package web

import (
	"fish-controller/internal/hub"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestVisionFrameSocketAuthenticatesAndStreamsCompactFrames(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	store := newAuthStore(authStorePath())
	if _, err := store.createUser("蓝队", "1", "1", "User"); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var requested url.Values
	vision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/frame.jpg" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		requested = r.URL.Query()
		mu.Unlock()
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("X-Fish-Frame-Sequence", "1")
		_, _ = w.Write([]byte{0xff, 0xd8, 0xff, 0xd9})
	}))
	defer vision.Close()
	app := httptest.NewServer(NewHandlerWithVision(hub.New(), testKey(), vision.URL, vision.URL))
	defer app.Close()
	websocketURL := "ws" + strings.TrimPrefix(app.URL, "http") + "/api/vision/frame.ws?sessionId=current&view=cropped"
	if conn, response, err := websocket.DefaultDialer.Dial(websocketURL, nil); err == nil {
		conn.Close()
		t.Fatal("anonymous viewer opened the camera socket")
	} else if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous camera status = %v, error = %v", response, err)
	}
	login, err := http.Post(app.URL+"/api/auth/login", "application/json", strings.NewReader(`{"email":"1","password":"1"}`))
	if err != nil {
		t.Fatal(err)
	}
	login.Body.Close()
	if login.StatusCode != http.StatusOK || len(login.Cookies()) == 0 {
		t.Fatalf("login status = %d", login.StatusCode)
	}
	header := http.Header{"Origin": {app.URL}, "Cookie": {login.Cookies()[0].String()}}
	fullURL := strings.Replace(websocketURL, "view=cropped", "view=full", 1)
	if conn, response, err := websocket.DefaultDialer.Dial(fullURL, header); err == nil {
		conn.Close()
		t.Fatal("player opened the referee's full camera view")
	} else if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("full-view status = %v, error = %v", response, err)
	}
	conn, response, err := websocket.DefaultDialer.Dial(websocketURL, header)
	if err != nil {
		t.Fatalf("viewer socket: response = %v, error = %v", response, err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	kind, frame, err := conn.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || string(frame) != string([]byte{0xff, 0xd8, 0xff, 0xd9}) {
		t.Fatalf("unexpected camera frame: kind = %d, bytes = %x, error = %v", kind, frame, err)
	}
	mu.Lock()
	got := requested
	mu.Unlock()
	if got.Get("sessionId") != "current" || got.Get("view") != "cropped" || got.Get("quality") != "compact" {
		t.Fatalf("upstream camera request = %v", got)
	}
}
