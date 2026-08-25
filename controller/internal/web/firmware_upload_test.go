package web

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fish-controller/internal/hub"
)

func TestFirmwareUploadAndMetadata(t *testing.T) {
	handler := NewHandlerWithFirmware(hub.New(), testKey(), "")
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("firmware", "firmware.bin")
	if err != nil {
		t.Fatal(err)
	}
	firmware := []byte{0xE9, 0x01, 0x02, 0x03, 0x04}
	if _, err := part.Write(firmware); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodPost, "/api/firmware", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}
	var uploaded map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded["available"] != true || uploaded["name"] != "firmware.bin" || uploaded["sha256"] == "" {
		t.Fatalf("上传元数据异常: %#v", uploaded)
	}

	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/firmware", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"available":true`) {
		t.Fatalf("固件元数据接口异常: %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/firmware/current.bin", nil))
	if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), firmware) {
		t.Fatalf("固件下载异常: %d", w.Code)
	}
}

func TestFirmwareUploadRejectsInvalidImage(t *testing.T) {
	handler := NewHandlerWithFirmware(hub.New(), testKey(), "")
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("firmware", "bad.bin")
	_, _ = part.Write([]byte{0x00, 0x01, 0x02, 0x03})
	_ = writer.Close()

	r := httptest.NewRequest(http.MethodPost, "/api/firmware", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("无效镜像应被拒绝: %d %s", w.Code, w.Body.String())
	}
}
