package visionprocess

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestFindDirSelectsDirectoryContainingServerScript(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing")
	valid := filepath.Join(root, "vision")
	if err := os.Mkdir(valid, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(valid, "server.py"), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	dir, err := FindDir(missing, valid)
	if err != nil || dir != valid {
		t.Fatalf("dir=%q err=%v", dir, err)
	}
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
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if starts != 0 || manager.OwnsProcess() {
		t.Fatalf("starts=%d owns=%v", starts, manager.OwnsProcess())
	}
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
	if err != nil {
		t.Fatal(err)
	}
	if !manager.OwnsProcess() {
		t.Fatal("expected owned process")
	}
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	server.Close()
	if !process.killed.Load() {
		t.Fatal("owned process was not stopped")
	}
}

func TestWatchdogRestartsBackendAfterConsecutiveHealthFailures(t *testing.T) {
	t.Setenv("FISH_VISION_WATCHDOG_FAILURES", "2")
	var healthy atomic.Bool
	healthy.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !healthy.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	var starts atomic.Int32
	manager, err := Ensure(server.URL, func(string) (Process, error) {
		starts.Add(1)
		healthy.Store(true)
		return &fakeProcess{}, nil
	}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	healthy.Store(false)
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && starts.Load() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if starts.Load() != 1 || !healthy.Load() {
		t.Fatalf("starts=%d healthy=%v", starts.Load(), healthy.Load())
	}
}

func TestPythonSourceFingerprintOnlyTracksPythonSources(t *testing.T) {
	root := t.TempDir()
	pythonPath := filepath.Join(root, "main.py")
	textPath := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(pythonPath, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(textPath, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	before, err := pythonSourceFingerprint(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(textPath, []byte("two-two"), 0o644); err != nil {
		t.Fatal(err)
	}
	unchanged, err := pythonSourceFingerprint(root)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged != before {
		t.Fatal("non-Python source changed the fingerprint")
	}
	if err := os.WriteFile(pythonPath, []byte("two-two"), 0o644); err != nil {
		t.Fatal(err)
	}
	after, err := pythonSourceFingerprint(root)
	if err != nil {
		t.Fatal(err)
	}
	if after == before {
		t.Fatal("Python source did not change the fingerprint")
	}
}

func TestSourceReloadStopsDevicesBeforeRestartingOwnedBackend(t *testing.T) {
	root := t.TempDir()
	pythonPath := filepath.Join(root, "main.py")
	if err := os.WriteFile(pythonPath, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()
	first := &fakeProcess{}
	var starts atomic.Int32
	var stopped atomic.Bool
	manager := &Manager{
		baseURL: server.URL, process: first, client: &http.Client{Timeout: 500 * time.Millisecond},
		start: func(string) (Process, error) {
			if !stopped.Load() {
				t.Error("backend restarted before safety callback")
			}
			starts.Add(1)
			return &fakeProcess{}, nil
		},
		startupTimeout: time.Second, failureThreshold: 20,
		stop: make(chan struct{}), done: make(chan struct{}),
	}
	if err := manager.EnableSourceReload(root, func() { stopped.Store(true) }); err != nil {
		t.Fatal(err)
	}
	go manager.guard()
	defer manager.Close()
	if err := os.WriteFile(pythonPath, []byte("two-two"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && starts.Load() == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if starts.Load() != 1 || !stopped.Load() || !first.killed.Load() {
		t.Fatalf("starts=%d stopped=%v firstKilled=%v", starts.Load(), stopped.Load(), first.killed.Load())
	}
}
