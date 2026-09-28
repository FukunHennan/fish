package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDevelopmentFrontendServesSourcesAndInjectsReloadClient(t *testing.T) {
	root := t.TempDir()
	competitionDir := filepath.Join(root, "public", "competition")
	if err := os.MkdirAll(competitionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "competition.html"), []byte("<html><body>赛事页</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(competitionDir, "adapter.js"), []byte("window.ready=true"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := developmentFrontendHandler(root)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/competition.html", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "/__dev/revision") {
		t.Fatalf("development HTML = %d %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/competition/adapter.js", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "window.ready") {
		t.Fatalf("development asset = %d %s", w.Code, w.Body.String())
	}
}

func TestDevelopmentFrontendRevisionChangesWithSource(t *testing.T) {
	root := t.TempDir()
	competitionDir := filepath.Join(root, "public", "competition")
	if err := os.MkdirAll(competitionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	page := filepath.Join(root, "competition.html")
	asset := filepath.Join(competitionDir, "adapter.js")
	if err := os.WriteFile(page, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	before, err := developmentFrontendRevision(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("two-two"), 0o644); err != nil {
		t.Fatal(err)
	}
	after, err := developmentFrontendRevision(root)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("frontend revision did not change")
	}
}
