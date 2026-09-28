package web

import (
	"encoding/json"
	"fish-controller/internal/hub"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMotionGeometryDoesNotClipExplicitSteeringToServoEnvelope(t *testing.T) {
	profile := defaultMotionProfile()
	profile.DeviceID = "fish"
	profile.ServoMin, profile.ServoMax, profile.StraightCenter = 80, 160, 100
	data, err := json.Marshal(map[string]motionCalibrationProfile{"fish": profile})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "calibrations.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	s := &server{calibrationPath: path}
	_, amplitude, bias, _ := s.applyMotionGeometry("fish", "forward", 2.5, 90, 90, true, nil)
	if amplitude != 90 || bias != 90 {
		t.Fatalf("explicit steering was clipped to servo envelope: amplitude=%v bias=%v", amplitude, bias)
	}
}

func TestMotionEndpointsPreserveExplicitSteeringAndCalibrationPreset(t *testing.T) {
	for _, tc := range []struct {
		name, path, body string
		amplitude, bias  float64
	}{
		{"manual", "/api/command", `{"deviceId":"fish","mode":"forward","frequency":2.5,"amplitude":45,"bias":55}`, 45, 55},
		{"keyboard", "/api/command/realtime", `{"deviceId":"fish","mode":"forward","frequency":2.5,"amplitudePercent":100,"bias":55,"sequence":1}`, 10, 55},
		{"vision", "/api/vision/device-command", `{"operation":"motion","deviceId":"fish","sessionId":"s","mode":"forward","frequency":2.5,"amplitude":45,"bias":90}`, 45, 90},
		{"calibration", "/api/vision/device-command", `{"operation":"calibrate-forward","deviceId":"fish","sessionId":"s"}`, 22, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := defaultMotionProfile()
			profile.DeviceID = "fish"
			profile.ServoMin, profile.ServoMax, profile.StraightCenter = 80, 160, 100
			data, err := json.Marshal(map[string]motionCalibrationProfile{"fish": profile})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "calibrations.json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("FISH_MOTION_CALIBRATIONS", path)
			t.Setenv("FISH_AUTH_DISABLED", "true")
			h := hub.New()
			written := make(chan map[string]any, 1)
			c := &captureConn{onWrite: func(value any) {
				message := value.(map[string]any)
				written <- message["payload"].(map[string]any)
				h.ResolveCommandResult(map[string]any{"requestId": message["requestId"], "success": true})
			}}
			h.Register(hub.Device{ID: "fish"}, c)
			defer h.Remove("fish", c)
			if tc.path == "/api/vision/device-command" {
				prepareVisionSession(t, h, "fish", "s", c)
				<-written
			}
			handler := NewHandler(h, testKey())
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body)))
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			select {
			case payload := <-written:
				if payload["amplitude"] != tc.amplitude || payload["bias"] != tc.bias {
					t.Fatalf("unsafe payload: %v; want amplitude=%v bias=%v", payload, tc.amplitude, tc.bias)
				}
				if payload["transitionMs"] != float64(600) {
					t.Fatalf("motion payload missing calibrated transition: %v", payload)
				}
			case <-time.After(time.Second):
				t.Fatal("device did not receive command")
			}
		})
	}
}
