package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"fish-controller/internal/hub"
)

func TestDeviceNicknamePersistsByDeviceIDAcrossRestart(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "true")
	t.Setenv("FISH_DEVELOPMENT_MODE", "false")
	t.Setenv("FISH_DEVICE_NAMES", filepath.Join(t.TempDir(), "device-names.json"))
	t.Setenv("FISH_COMPETITION_STATE", filepath.Join(t.TempDir(), "competition.json"))

	handler := NewHandler(hub.New(), testKey())
	request := httptest.NewRequest(http.MethodPatch, "/api/device-names", strings.NewReader(
		`{"deviceId":"ac:27:6e:7c:37:18","name":"池塘一号"}`,
	))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("save nickname -> %d %s", response.Code, response.Body.String())
	}

	restartedHub := hub.New()
	restartedHub.Register(hub.Device{ID: "AC:27:6E:7C:37:18", Name: "机器鱼"}, assignmentTestConn{})
	restarted := NewHandler(restartedHub, testKey())
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/devices", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("list devices -> %d %s", response.Code, response.Body.String())
	}
	var devices []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &devices); err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0]["name"] != "池塘一号" {
		t.Fatalf("nickname was not restored after restart: %+v", devices)
	}
}
