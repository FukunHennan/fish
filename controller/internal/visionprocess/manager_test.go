package visionprocess

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFindDirSelectsDirectoryContainingServerScript(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing")
	valid := filepath.Join(root, "vision")
	if err := os.Mkdir(valid, 0o755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(valid, "server.py"), []byte(""), 0o644); err != nil { t.Fatal(err) }

	dir, err := FindDir(missing, valid)
	if err != nil || dir != valid { t.Fatalf("dir=%q err=%v", dir, err) }
}

type fakeProcess struct{ killed atomic.Bool }
func (p *fakeProcess) Kill() error { p.killed.Store(true); return nil }
func (p *fakeProcess) Wait() error { return nil }

func TestEnsureReusesHealthyVisionServiceWithoutStartingProcess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	starts := 0

	manager, err := Ensure(server.URL, func(string) (Process, error) {
		starts++
		return &fakeProcess{}, nil
	}, time.Second)
	if err != nil { t.Fatal(err) }
	defer manager.Close()
	if starts != 0 || manager.OwnsProcess() { t.Fatalf("starts=%d owns=%v", starts, manager.OwnsProcess()) }
}

func TestEnsureStartsAndLaterStopsOwnedVisionProcess(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	baseURL := "http://" + server.Listener.Addr().String()
	process := &fakeProcess{}

	manager, err := Ensure(baseURL, func(string) (Process, error) {
		server.Start()
		return process, nil
	}, time.Second)
	if err != nil { t.Fatal(err) }
	if !manager.OwnsProcess() { t.Fatal("expected owned process") }
	if err := manager.Close(); err != nil { t.Fatal(err) }
	server.Close()
	if !process.killed.Load() { t.Fatal("owned process was not stopped") }
}
