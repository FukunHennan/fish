package visionproxy

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

type Handler struct {
	api    *httputil.ReverseProxy
	stream *httputil.ReverseProxy
}

func New(apiAddress, streamAddress string) (*Handler, error) {
	apiURL, err := url.Parse(apiAddress)
	if err != nil {
		return nil, fmt.Errorf("解析视觉 API 地址: %w", err)
	}
	streamURL, err := url.Parse(streamAddress)
	if err != nil {
		return nil, fmt.Errorf("解析视觉视频地址: %w", err)
	}
	api := httputil.NewSingleHostReverseProxy(apiURL)
	stream := httputil.NewSingleHostReverseProxy(streamURL)
	stream.FlushInterval = -time.Second
	stream.ModifyResponse = func(response *http.Response) error {
		response.Header.Set("Cache-Control", "no-store, no-cache, must-revalidate, private, max-age=0, no-transform")
		response.Header.Set("Pragma", "no-cache")
		response.Header.Set("Expires", "0")
		response.Header.Set("X-Accel-Buffering", "no")
		return nil
	}
	return &Handler{api: api, stream: stream}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	clone := r.Clone(r.Context())
	if r.URL.Path == "/api/vision/stream.mjpg" ||
		(strings.HasPrefix(r.URL.Path, "/api/vision/sessions/") && strings.HasSuffix(r.URL.Path, "/stream.mjpg")) {
		clone.URL.Path = "/video.mjpg"
		clone.Header.Set("Cache-Control", "no-store")
		clone.Header.Set("Pragma", "no-cache")
		h.stream.ServeHTTP(w, clone)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/vision/") {
		http.NotFound(w, r)
		return
	}
	clone.URL.Path = "/" + strings.TrimPrefix(r.URL.Path, "/api/vision/")
	h.api.ServeHTTP(w, clone)
}
