package visionprocess

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type Process interface {
	Kill() error
	Wait() error
}

type StartFunc func(visionDir string) (Process, error)

type Manager struct {
	baseURL string
	process Process
	client  *http.Client
}

func FindDir(candidates ...string) (string, error) {
	for _, candidate := range candidates {
		path, err := filepath.Abs(candidate)
		if err != nil { continue }
		if info, err := os.Stat(filepath.Join(path, "server.py")); err == nil && !info.IsDir() {
			return path, nil
		}
	}
	return "", fmt.Errorf("未找到 vision/server.py")
}

func Ensure(baseURL string, start StartFunc, timeout time.Duration) (*Manager, error) {
	manager := &Manager{baseURL: baseURL, client: &http.Client{Timeout: 500 * time.Millisecond}}
	if manager.healthy() { return manager, nil }
	process, err := start("")
	if err != nil { return nil, fmt.Errorf("启动视觉后台: %w", err) }
	manager.process = process
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if manager.healthy() { return manager, nil }
		time.Sleep(100 * time.Millisecond)
	}
	_ = process.Kill()
	_ = process.Wait()
	return nil, fmt.Errorf("视觉后台在 %s 内未就绪", timeout)
}

func (m *Manager) healthy() bool {
	response, err := m.client.Get(m.baseURL + "/health")
	if err != nil { return false }
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode == http.StatusOK
}

func (m *Manager) OwnsProcess() bool { return m.process != nil }

func (m *Manager) Close() error {
	if m.process == nil { return nil }
	response, _ := m.client.Post(m.baseURL+"/stop", "application/json", nil)
	if response != nil { response.Body.Close() }
	if err := m.process.Kill(); err != nil { return err }
	_ = m.process.Wait()
	m.process = nil
	return nil
}

type commandProcess struct{ command *exec.Cmd }
func (p *commandProcess) Kill() error { return p.command.Process.Kill() }
func (p *commandProcess) Wait() error { return p.command.Wait() }

func PythonStarter(visionDir string) StartFunc {
	return func(_ string) (Process, error) {
		command := exec.Command("py", "-3.14", "server.py")
		command.Dir = visionDir
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
		if err := command.Start(); err != nil { return nil, err }
		return &commandProcess{command: command}, nil
	}
}
