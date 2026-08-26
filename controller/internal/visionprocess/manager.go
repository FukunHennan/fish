package visionprocess

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

type PythonCommand struct {
	Executable string
	PrefixArgs []string
	Source     string
}

func FindDir(candidates ...string) (string, error) {
	for _, candidate := range candidates {
		path, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		if info, err := os.Stat(filepath.Join(path, "server.py")); err == nil && !info.IsDir() {
			return path, nil
		}
	}
	return "", fmt.Errorf("未找到 vision/server.py")
}

func Ensure(baseURL string, start StartFunc, timeout time.Duration) (*Manager, error) {
	manager := &Manager{baseURL: baseURL, client: &http.Client{Timeout: 500 * time.Millisecond}}
	if manager.healthy() {
		return manager, nil
	}
	process, err := start("")
	if err != nil {
		return nil, fmt.Errorf("启动视觉后台: %w", err)
	}
	manager.process = process
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if manager.healthy() {
			return manager, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = process.Kill()
	_ = process.Wait()
	return nil, fmt.Errorf("视觉后台在 %s 内未就绪", timeout)
}

func (m *Manager) healthy() bool {
	response, err := m.client.Get(m.baseURL + "/health")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode == http.StatusOK
}

func (m *Manager) OwnsProcess() bool { return m.process != nil }

func (m *Manager) Close() error {
	if m.process == nil {
		return nil
	}
	response, _ := m.client.Post(m.baseURL+"/stop", "application/json", nil)
	if response != nil {
		response.Body.Close()
	}
	if err := m.process.Kill(); err != nil {
		return err
	}
	_ = m.process.Wait()
	m.process = nil
	return nil
}

type commandProcess struct{ command *exec.Cmd }

func (p *commandProcess) Kill() error { return p.command.Process.Kill() }
func (p *commandProcess) Wait() error { return p.command.Wait() }

func ResolvePython(visionDir string) (PythonCommand, error) {
	if configured := strings.TrimSpace(os.Getenv("FISH_PYTHON")); configured != "" {
		if strings.ContainsAny(configured, `/\\`) {
			if info, err := os.Stat(configured); err == nil && !info.IsDir() {
				return PythonCommand{Executable: configured, Source: "FISH_PYTHON"}, nil
			}
			return PythonCommand{}, fmt.Errorf("FISH_PYTHON 指向的解释器不存在: %s", configured)
		}
		if found, err := exec.LookPath(configured); err == nil {
			return PythonCommand{Executable: found, Source: "FISH_PYTHON"}, nil
		}
		return PythonCommand{}, fmt.Errorf("无法在 PATH 中找到 FISH_PYTHON=%s", configured)
	}

	repoRoot := filepath.Dir(visionDir)
	venvCandidates := []string{}
	if runtime.GOOS == "windows" {
		venvCandidates = append(venvCandidates,
			filepath.Join(visionDir, ".venv", "Scripts", "python.exe"),
			filepath.Join(repoRoot, ".venv", "Scripts", "python.exe"),
		)
	} else {
		venvCandidates = append(venvCandidates,
			filepath.Join(visionDir, ".venv", "bin", "python"),
			filepath.Join(repoRoot, ".venv", "bin", "python"),
		)
	}
	for _, candidate := range venvCandidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return PythonCommand{Executable: candidate, Source: "project_venv"}, nil
		}
	}

	for _, name := range []string{"python", "python3"} {
		if found, err := exec.LookPath(name); err == nil {
			return PythonCommand{Executable: found, Source: "PATH"}, nil
		}
	}
	if runtime.GOOS == "windows" {
		if found, err := exec.LookPath("py"); err == nil {
			return PythonCommand{Executable: found, PrefixArgs: []string{"-3"}, Source: "py_launcher"}, nil
		}
	}
	return PythonCommand{}, fmt.Errorf("未找到可用 Python。请运行 scripts/setup.ps1 或设置 FISH_PYTHON")
}

func PythonStarter(visionDir string) StartFunc {
	return PythonStarterWithOutput(visionDir, os.Stdout, os.Stderr)
}

func PythonStarterWithOutput(visionDir string, stdout, stderr io.Writer) StartFunc {
	return func(_ string) (Process, error) {
		python, err := ResolvePython(visionDir)
		if err != nil {
			return nil, err
		}
		args := append(append([]string{}, python.PrefixArgs...), "server.py")
		command := exec.Command(python.Executable, args...)
		command.Dir = visionDir
		command.Stdout = stdout
		command.Stderr = stderr
		if err := command.Start(); err != nil {
			return nil, err
		}
		return &commandProcess{command: command}, nil
	}
}
