package web

import (
	"encoding/json"
	"fish-controller/internal/hub"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEveryLeaseCleanupDeliversExpiredStop(t *testing.T) {
	for _, trigger := range []string{"acquire", "exclusive", "touch", "release", "watchdog", "admit"} {
		t.Run(trigger, func(t *testing.T) {
			l := newLeaseStore(time.Minute)
			var stopped []string
			l.onRelease = func(id string) { stopped = append(stopped, id) }
			l.leases["expired"] = controlLease{OwnerID: "old", ExpiresAt: time.Now().Add(-time.Second)}
			switch trigger {
			case "acquire":
				l.acquire("other", authUser{ID: "u"}, "manual", false)
			case "exclusive":
				l.acquireExclusive("other", authUser{ID: "u"}, "manual", false)
			case "touch":
				l.touch("other", authUser{ID: "u"})
			case "release":
				l.release("other", authUser{ID: "u"}, false)
			case "watchdog":
				l.expire()
			case "admit":
				l.admit("other", authUser{ID: "u"}, "", false, func() bool { return true })
			}
			l.expire()
			count := 0
			for _, id := range stopped {
				if id == "expired" {
					count++
				}
			}
			if count != 1 {
				t.Fatalf("expired stop count=%d", count)
			}
		})
	}
}

func TestLeaseReplacementQueuesStopBeforeNewMotion(t *testing.T) {
	l := newLeaseStore(time.Minute)
	user := authUser{ID: "user"}
	l.leases["fish"] = controlLease{OwnerID: "old", ExpiresAt: time.Now().Add(-time.Second)}
	var events []string
	l.onRelease = func(string) { events = append(events, "stop") }
	l.acquireExclusive("fish", user, "manual", false, "browser")
	if !l.admit("fish", user, "browser", true, func() bool { events = append(events, "motion"); return true }) {
		t.Fatal("new owner denied")
	}
	if len(events) < 2 || events[0] != "stop" || events[len(events)-1] != "motion" {
		t.Fatalf("order=%v", events)
	}
	if l.admit("fish", user, "old-browser", true, func() bool { t.Fatal("old client reached queue"); return true }) {
		t.Fatal("old client allowed")
	}
}

type lifecycleConn struct {
	h     *hub.Hub
	mu    sync.Mutex
	modes []string
}

func (c *lifecycleConn) WriteJSON(value any) error {
	m := value.(map[string]any)
	if p, ok := m["payload"].(map[string]any); ok {
		c.mu.Lock()
		c.modes = append(c.modes, fmt.Sprint(p["mode"]))
		c.mu.Unlock()
	}
	c.h.ResolveCommandResult(map[string]any{"requestId": m["requestId"], "success": true})
	return nil
}
func (c *lifecycleConn) Close() error { return nil }

func TestBrowserTakeoverResetsSequenceAndRejectsPreviousClient(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "true")
	t.Setenv("FISH_MOTION_CALIBRATIONS", filepath.Join(t.TempDir(), "calibration.json"))
	h := hub.New()
	c := &lifecycleConn{h: h}
	h.Register(hub.Device{ID: "fish"}, c)
	defer h.Remove("fish", c)
	handler := NewHandler(h, testKey())
	post := func(path string, payload map[string]any, want int) {
		t.Helper()
		data, _ := json.Marshal(payload)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(data))))
		if w.Code != want {
			t.Fatalf("%s status=%d want=%d body=%s", path, w.Code, want, w.Body.String())
		}
	}
	claim := func(client string) { post("/api/leases", map[string]any{"deviceId": "fish", "clientId": client}, 200) }
	motion := func(client, mode string, seq uint64, want int) {
		post("/api/command/realtime", map[string]any{"deviceId": "fish", "clientId": client, "mode": mode, "sequence": seq, "frequency": 2.5, "amplitude": 0}, want)
	}
	claim("ahead")
	motion("ahead", "forward", 1000000, 200)
	claim("behind")
	motion("behind", "forward", 1, 200)
	motion("ahead", "forward", 1000001, 409)
	motion("ahead", "stop", 1000002, 200)
	motion("behind", "forward", 2, 200)
	motion("behind", "stop", 1, 200)
	motion("behind", "forward", 1, 409)
}

func TestVisionMustStartAndCannotResumeExpiredSession(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "true")
	h := hub.New()
	c := &lifecycleConn{h: h}
	h.Register(hub.Device{ID: "fish"}, c)
	defer h.Remove("fish", c)
	s := &server{hub: h, leases: newLeaseStore(time.Minute), calibrationPath: filepath.Join(t.TempDir(), "calibration.json")}
	s.leases.onRelease = func(id string) { h.StopAndReset(id) }
	send := func(op, session string, want int) {
		t.Helper()
		w := httptest.NewRecorder()
		s.visionDeviceCommand(w, httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(fmt.Sprintf(`{"deviceId":"fish","operation":%q,"sessionId":%q,"mode":"forward","frequency":2.5,"amplitude":0}`, op, session))))
		if w.Code != want {
			t.Fatalf("%s %s status=%d want=%d %s", op, session, w.Code, want, w.Body.String())
		}
	}
	send("motion", "old", 409)
	send("start", "old", 200)
	send("motion", "old", 200)
	h.StopExpiredVisionMotion(time.Now().Add(4 * time.Second))
	s.leases.releaseIdleVision(h.VisionSessionActive)
	send("motion", "old", 409)
	send("start", "new", 200)
	send("motion", "new", 200)
	send("stop", "old", 409)
	send("motion", "new", 200)
	h.StopAndReset("fish")
	send("motion", "new", 409)
}

func TestAdminMotionRequiresLeaseAndRenewalCannotTakeOver(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	t.Setenv("FISH_INVITE_CODE", "")
	h := hub.New()
	c := &lifecycleConn{h: h}
	h.Register(hub.Device{ID: "fish"}, c)
	defer h.Remove("fish", c)
	handler := NewHandler(h, testKey())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(`{"name":"Admin","email":"admin@example.com","password":"admin-pass-123"}`)))
	if w.Code != 200 || len(w.Result().Cookies()) == 0 {
		t.Fatalf("register: %s", w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	send := func(method, path, body string, want int) {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/api/command", "/api/command/realtime"} {
		send("POST", path, `{"deviceId":"fish","mode":"forward","sequence":1,"frequency":2.5,"amplitude":0}`, 409)
	}
	send("PATCH", "/api/leases", `{"deviceId":"fish","clientId":"a"}`, 409)
	send("POST", "/api/leases", `{"deviceId":"fish","clientId":"a"}`, 200)
	send("PATCH", "/api/leases", `{"deviceId":"fish","clientId":"a"}`, 200)
	send("PATCH", "/api/leases", `{"deviceId":"fish","clientId":"b"}`, 409)
	for _, path := range []string{"/api/command", "/api/command/realtime"} {
		send("POST", path, `{"deviceId":"fish","mode":"forward","sequence":1,"frequency":2.5,"amplitude":0}`, 409)
		send("POST", path, `{"deviceId":"fish","mode":"stop","sequence":1,"frequency":2.5,"amplitude":0}`, 200)
	}
	send("DELETE", "/api/leases", `{"deviceId":"fish","clientId":"a"}`, 200)
	send("PATCH", "/api/leases", `{"deviceId":"fish","clientId":"a"}`, 409)
}
