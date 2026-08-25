package visionproxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandlerRoutesAPIsAndStreamToSeparateLoopbackServices(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" { t.Fatalf("API path = %q", r.URL.Path) }
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"state":"running"}`)
	}))
	defer api.Close()
	stream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/video.mjpg" { t.Fatalf("stream path = %q", r.URL.Path) }
		w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")
		_, _ = io.WriteString(w, "frame-data")
	}))
	defer stream.Close()

	handler, err := New(api.URL, stream.URL)
	if err != nil { t.Fatal(err) }

	apiRequest := httptest.NewRequest(http.MethodGet, "/api/vision/status", nil)
	apiResponse := httptest.NewRecorder()
	handler.ServeHTTP(apiResponse, apiRequest)
	if apiResponse.Code != http.StatusOK || apiResponse.Body.String() != `{"state":"running"}` {
		t.Fatalf("API response = %d %q", apiResponse.Code, apiResponse.Body.String())
	}

	streamRequest := httptest.NewRequest(http.MethodGet, "/api/vision/stream.mjpg", nil)
	streamResponse := httptest.NewRecorder()
	handler.ServeHTTP(streamResponse, streamRequest)
	if streamResponse.Code != http.StatusOK || streamResponse.Body.String() != "frame-data" {
		t.Fatalf("stream response = %d %q", streamResponse.Code, streamResponse.Body.String())
	}

	sessionStreamRequest := httptest.NewRequest(http.MethodGet, "/api/vision/sessions/abc/stream.mjpg", nil)
	sessionStreamResponse := httptest.NewRecorder()
	handler.ServeHTTP(sessionStreamResponse, sessionStreamRequest)
	if sessionStreamResponse.Code != http.StatusOK || sessionStreamResponse.Body.String() != "frame-data" {
		t.Fatalf("session stream response = %d %q", sessionStreamResponse.Code, sessionStreamResponse.Body.String())
	}
}
