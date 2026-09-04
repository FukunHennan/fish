package web

import (
	"fish-controller/internal/hub"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVisionMotionStopsWithoutPythonUpdates(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "true")
	t.Setenv("FISH_MOTION_CALIBRATIONS", filepath.Join(t.TempDir(), "calibration.json"))
	h := hub.New()
	stopped := make(chan struct{}, 1)
	c := &captureConn{onWrite: func(value any) {
		message := value.(map[string]any)
		if payload, ok := message["payload"].(map[string]any); ok && payload["mode"] == "stop" {
			select {
			case stopped <- struct{}{}:
			default:
			}
		}
		h.ResolveCommandResult(map[string]any{"requestId": message["requestId"], "success": true})
	}}
	h.Register(hub.Device{ID: "fish"}, c)
	defer h.Remove("fish", c)
	prepareVisionSession(t, h, "fish", "s", c)
	<-stopped
	handler := NewHandler(h, testKey())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(
		`{"operation":"motion","deviceId":"fish","sessionId":"s","mode":"forward","frequency":2.5,"amplitude":20}`,
	)))
	if response.Code != http.StatusOK {
		t.Fatalf("motion failed: %d %s", response.Code, response.Body.String())
	}
	// Both transport directions stay healthy, but Python sends no more motion.
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(4 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-stopped:
			return
		case <-ticker.C:
			h.Update("fish", map[string]any{"mode": 2.0})
			h.Send("fish", map[string]any{"type": "heartbeat"})
		case <-deadline.C:
			t.Fatal("vision stopped producing commands but Go never sent STOP")
		}
	}
}

func TestVisionCalibrationTimeoutWithAndWithoutAuthentication(t *testing.T) {
	for _, authDisabled := range []string{"true", "false"} {
		t.Run(authDisabled, func(t *testing.T) {
			t.Setenv("FISH_AUTH_DISABLED", authDisabled)
			t.Setenv("FISH_VISION_INTERNAL_TOKEN", "test-internal")
			h := hub.New()
			written := make(chan string, 4)
			c := &captureConn{onWrite: func(value any) {
				message := value.(map[string]any)
				payload := message["payload"].(map[string]any)
				written <- payload["mode"].(string)
				h.ResolveCommandResult(map[string]any{"requestId": message["requestId"], "success": true})
			}}
			h.Register(hub.Device{ID: "fish"}, c)
			defer h.Remove("fish", c)
			prepareVisionSession(t, h, "fish", "s", c)
			<-written
			s := &server{hub: h, leases: newLeaseStore(time.Minute), calibrationPath: filepath.Join(t.TempDir(), "calibration.json")}
			for _, duration := range []int{-1, 5001} {
				r := httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(fmt.Sprintf(`{"operation":"calibrate-forward","sessionId":"s","deviceId":"fish","durationMs":%d}`, duration)))
				r.Header.Set("X-Fish-Vision-Internal", "test-internal")
				w := httptest.NewRecorder()
				s.visionDeviceCommand(w, r)
				if w.Code != http.StatusBadRequest {
					t.Fatalf("invalid duration accepted: %d", duration)
				}
			}
			r := httptest.NewRequest(http.MethodPost, "/api/vision/device-command", strings.NewReader(`{"operation":"calibrate-forward","sessionId":"s","deviceId":"fish","durationMs":100}`))
			r.Header.Set("X-Fish-Vision-Internal", "test-internal")
			w := httptest.NewRecorder()
			s.visionDeviceCommand(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("calibration failed: %d %s", w.Code, w.Body.String())
			}
			if mode := <-written; mode != "forward" {
				t.Fatalf("first mode=%s", mode)
			}
			if stopped := h.StopExpiredVisionMotion(time.Now().Add(time.Second)); len(stopped) != 1 {
				t.Fatal("durationMs was not enforced")
			}
			select {
			case mode := <-written:
				if mode != "stop" {
					t.Fatalf("expired mode=%s", mode)
				}
			case <-time.After(time.Second):
				t.Fatal("missing calibration STOP")
			}
		})
	}
}
