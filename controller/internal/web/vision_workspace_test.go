package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestVisionWorkspaceRequiresCurrentBrowserLeaseAndOverwritesIdentity(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "true")
	s := &server{leases: newLeaseStore(time.Minute)}
	user := s.anonymousAdmin()
	s.leases.acquireExclusive("fish-1", user, "vision", false, "tab-a")
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Fish-Workspace-User"); got != user.ID {
			t.Fatalf("owner header = %q", got)
		}
		if got := r.Header.Get("X-Fish-Workspace-Client"); got != "tab-a" {
			t.Fatalf("client header = %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	handler := s.authenticatedVisionProxy(next)

	req := httptest.NewRequest(http.MethodGet, "/api/vision/workspaces/fish-1/sessions/current", nil)
	req.Header.Set("X-Fish-Client", "tab-a")
	req.Header.Set("X-Fish-Workspace-User", "forged")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent { t.Fatalf("status = %d", w.Code) }

	req = httptest.NewRequest(http.MethodGet, "/api/vision/workspaces/fish-1/sessions/current", nil)
	req.Header.Set("X-Fish-Client", "tab-b")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusConflict { t.Fatalf("foreign browser status = %d", w.Code) }
}
