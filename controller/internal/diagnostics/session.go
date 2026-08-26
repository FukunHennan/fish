package diagnostics

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

type Session struct {
	ID         string
	Dir        string
	Logger     *slog.Logger
	controller *os.File
	console    *os.File
	python     *os.File
	mu         sync.Mutex
}

type RuntimeInfo struct {
	SessionID  string   `json:"sessionId"`
	StartedAt  string   `json:"startedAt"`
	GOOS       string   `json:"goos"`
	GOARCH     string   `json:"goarch"`
	GoVersion  string   `json:"goVersion"`
	PID        int      `json:"pid"`
	Args       []string `json:"args"`
	WorkingDir string   `json:"workingDir"`
}

func New(root string) (*Session, error) {
	if root == "" {
		root = filepath.Join("diagnostics", "runs")
	}
	now := time.Now()
	id := fmt.Sprintf("%s-%d", now.Format("20060102-150405"), os.Getpid())
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	structured, err := os.OpenFile(filepath.Join(dir, "controller.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	console, err := os.OpenFile(filepath.Join(dir, "controller.txt"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		structured.Close()
		return nil, err
	}
	python, err := os.OpenFile(filepath.Join(dir, "python-vision.txt"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		structured.Close()
		console.Close()
		return nil, err
	}

	handler := slog.NewJSONHandler(structured, &slog.HandlerOptions{Level: slog.LevelDebug})
	s := &Session{
		ID:         id,
		Dir:        dir,
		Logger:     slog.New(handler).With("session", id),
		controller: structured,
		console:    console,
		python:     python,
	}

	// Preserve existing log.Printf output while also persisting it per run.
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.Lshortfile)
	log.SetOutput(io.MultiWriter(os.Stdout, console))

	wd, _ := os.Getwd()
	info := RuntimeInfo{
		SessionID:  id,
		StartedAt:  now.Format(time.RFC3339Nano),
		GOOS:       runtime.GOOS,
		GOARCH:     runtime.GOARCH,
		GoVersion:  runtime.Version(),
		PID:        os.Getpid(),
		Args:       append([]string(nil), os.Args...),
		WorkingDir: wd,
	}
	if data, err := json.MarshalIndent(info, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "runtime.json"), append(data, '\n'), 0o644)
	}
	_ = os.WriteFile(filepath.Join(root, "LATEST.txt"), []byte(id+"\n"), 0o644)
	s.Logger.Info("diagnostic_session_started", "dir", dir)
	return s, nil
}

func (s *Session) PythonWriter() io.Writer {
	return io.MultiWriter(os.Stdout, s.python)
}

func (s *Session) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Logger.Info("diagnostic_session_closed")
	var first error
	for _, file := range []*os.File{s.python, s.console, s.controller} {
		if file != nil {
			if err := file.Close(); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}
