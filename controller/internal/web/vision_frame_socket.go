package web

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// visionFrameSocket sends only the newest camera snapshot over one persistent
// HTTPS-tunnel-compatible connection. Slow viewers never accumulate old frames.
func (s *server) visionFrameSocket(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sessionID := strings.TrimSpace(r.URL.Query().Get("sessionId"))
	if sessionID == "" || len(sessionID) > 128 {
		http.Error(w, "Invalid vision session", http.StatusBadRequest)
		return
	}
	view := "cropped"
	if r.URL.Query().Get("view") == "full" {
		if !isRefereeAccount(user) {
			http.Error(w, "Full camera view requires referee account", http.StatusForbidden)
			return
		}
		view = "full"
	}
	// The default upgrader checks the Origin against Host; a logged-in page on
	// another website cannot use the session cookie to open this video socket.
	conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	started := time.Now()
	framesSent := 0
	bytesSent := int64(0)
	s.event("vision_frame_socket_connected", "view", view)
	defer func() {
		s.event("vision_frame_socket_closed", "view", view, "frames", framesSent,
			"bytes", bytesSent, "duration_ms", time.Since(started).Milliseconds())
	}()
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		conn.SetReadLimit(1024)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	endpoint, err := url.Parse(s.visionAPIAddress + "/frame.jpg")
	if err != nil {
		return
	}
	query := endpoint.Query()
	query.Set("sessionId", sessionID)
	query.Set("view", view)
	query.Set("quality", "compact")
	endpoint.RawQuery = query.Encode()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	lastSequence := ""
	lastAuthCheck := time.Time{}
	for {
		select {
		case <-closed:
			return
		case <-r.Context().Done():
			return
		default:
		}
		if time.Since(lastAuthCheck) > 5*time.Second {
			current, valid := s.currentUser(r)
			if !valid || current.ID != user.ID {
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Login expired"),
					time.Now().Add(time.Second))
				return
			}
			lastAuthCheck = time.Now()
		}
		request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return
		}
		response, err := s.visionHTTPClient.Do(request)
		if err == nil {
			if response.StatusCode == http.StatusConflict {
				response.Body.Close()
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Vision session changed"),
					time.Now().Add(time.Second))
				return
			}
			if response.StatusCode == http.StatusOK && strings.HasPrefix(response.Header.Get("Content-Type"), "image/jpeg") {
				sequence := response.Header.Get("X-Fish-Frame-Sequence")
				if sequence != "" && sequence != lastSequence {
					frame, readErr := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
					response.Body.Close()
					if readErr == nil && len(frame) > 0 && len(frame) <= 1<<20 {
						if err := conn.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
							return
						}
						if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
							return
						}
						framesSent++
						bytesSent += int64(len(frame))
						lastSequence = sequence
					}
				} else {
					response.Body.Close()
				}
			} else {
				response.Body.Close()
			}
		}
		select {
		case <-closed:
			return
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
