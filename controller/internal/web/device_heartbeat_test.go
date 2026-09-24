package web

import (
	"fish-controller/internal/hub"
	"fish-controller/internal/identity"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Exercise real WebSocket framing and deadline renewal beyond the initial
// timeout, using the same application heartbeat messages as the firmware.
func TestDeviceHeartbeatKeepsSocketAliveBeyondReadTimeout(t *testing.T) {
	key := make([]byte, 32)
	s := &server{hub: hub.New(), key: key}
	ts := httptest.NewServer(http.HandlerFunc(s.deviceSocket))
	defer ts.Close()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/device", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var challenge map[string]any
	if err := c.ReadJSON(&challenge); err != nil {
		t.Fatal(err)
	}
	if challenge["type"] != "auth.challenge" || challenge["protocolVersion"] != float64(2) {
		t.Fatalf("unexpected challenge: %v", challenge)
	}
	id := "02:00:00:00:00:01"
	proof, err := identity.Proof(key, "fish-websocket-v2", challenge["nonce"].(string), id)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(map[string]any{"type": "register", "protocolVersion": 2, "deviceId": id, "proof": proof}); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := c.ReadJSON(&result); err != nil {
		t.Fatal(err)
	}
	if result["type"] != "register.result" || result["success"] != true {
		t.Fatalf("registration failed: %v", result)
	}
	started := time.Now()
	count := 0
	for time.Since(started) < deviceHeartbeatTimeout+2*time.Second {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		var msg map[string]any
		if err := c.ReadJSON(&msg); err != nil {
			t.Fatalf("heartbeat %d: %v", count, err)
		}
		if msg["type"] != "heartbeat" {
			t.Fatalf("unexpected message: %v", msg)
		}
		if err := c.WriteJSON(map[string]any{"type": "heartbeat", "deviceId": id, "mode": 0, "uptimeMs": time.Since(started).Milliseconds()}); err != nil {
			t.Fatal(err)
		}
		count++
	}
	devices := s.hub.List()
	if len(devices) != 1 || devices[0].HeartbeatRTTMs <= 0 {
		t.Fatalf("未测得 WebSocket ping/pong RTT: %+v", devices)
	}
	t.Logf("exchanged %d heartbeats over %s", count, time.Since(started).Round(time.Millisecond))
}
