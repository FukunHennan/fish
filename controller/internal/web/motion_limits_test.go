package web

import (
	"encoding/json"
	"fish-controller/internal/hub"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMotionGeometryKeepsEntireSwingWithinServoLimits(t *testing.T) {
	defaults := defaultMotionProfile()
	defaults.DeviceID = "fish"
	modern := defaultMotionProfile()
	modern.DeviceID = "fish"
	modern.ServoMin, modern.ServoMax, modern.StraightCenter = 20, 150, 100
	legacy := motionCalibrationProfile{DeviceID: "fish", CenterDeg: 120, Frequency: 2.5, Amplitude: 28, LeftSign: -1, RightSign: 1, LeftMaxOffset: 30, RightMaxOffset: 30, TurnPercent: 60}
	for _, profile := range []motionCalibrationProfile{defaults, modern, legacy} {
		data, err := json.Marshal(map[string]motionCalibrationProfile{"fish": profile})
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "calibrations.json")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		s := &server{calibrationPath: path}
		minimum, maximum := profile.ServoMin, profile.ServoMax
		if maximum == 0 {
			minimum, maximum = 0, 180
		}
		for _, mode := range []string{"forward", "left", "right", "idle"} {
			for _, bias := range []float64{-90, -70, -15, 0, 15, 70, 90} {
				percent := 100.0
				for _, inputPercent := range []*float64{nil, &percent} {
					_, amplitude, appliedBias, _ := s.applyMotionGeometry("fish", mode, 2.5, 90, bias, true, inputPercent)
					center := motionStraightCenter(profile) + appliedBias
					if math.IsNaN(amplitude) || amplitude < 0 || center-amplitude < minimum-1e-9 || center+amplitude > maximum+1e-9 {
						t.Fatalf("mode=%s bias=%v percent=%v: output [%v,%v] outside [%v,%v]", mode, bias, inputPercent != nil, center-amplitude, center+amplitude, minimum, maximum)
					}
				}
			}
		}
	}
}

func TestMotionEndpointsLimitExplicitBiasAndCalibrationPreset(t *testing.T) {
	for _, tc := range []struct {
		name, path, body string
		amplitude, bias  float64
	}{
		{"manual", "/api/command", `{"deviceId":"fish","mode":"forward","frequency":2.5,"amplitude":45,"bias":55}`, 5, 55},
		{"keyboard", "/api/command/realtime", `{"deviceId":"fish","mode":"forward","frequency":2.5,"amplitudePercent":100,"bias":55,"sequence":1}`, 5, 55},
		{"vision", "/api/vision/device-command", `{"operation":"motion","deviceId":"fish","sessionId":"s","mode":"forward","frequency":2.5,"amplitude":45,"bias":90}`, 0, 60},
		{"calibration", "/api/vision/device-command", `{"operation":"calibrate-forward","deviceId":"fish","sessionId":"s"}`, 10, 0},
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
			case <-time.After(time.Second):
				t.Fatal("device did not receive command")
			}
		})
	}
}
