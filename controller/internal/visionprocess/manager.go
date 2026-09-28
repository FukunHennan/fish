package visionprocess

import (
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Process interface {
	Kill() error
	Wait() error
}

type StartFunc func(visionDir string) (Process, error)

type Manager struct {
	baseURL           string
	process           Process
	client            *http.Client
	start             StartFunc
	startupTimeout    time.Duration
	failureThreshold  int
	mu                sync.Mutex
	stop              chan struct{}
	done              chan struct{}
	closing           bool
	reloadDir         string
	reloadFingerprint string
	reloadCandidate   string
	reloadCandidateAt time.Time
	beforeReload      func()
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
	failureThreshold := 20
	if configured, err := strconv.Atoi(strings.TrimSpace(os.Getenv("FISH_VISION_WATCHDOG_FAILURES"))); err == nil && configured >= 2 {
		failureThreshold = configured
	}
	manager := &Manager{baseURL: baseURL, client: &http.Client{Timeout: 500 * time.Millisecond}, start: start, startupTimeout: timeout, failureThreshold: failureThreshold, stop: make(chan struct{}), done: make(chan struct{})}
	if manager.healthy() {
		go manager.guard()
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
			go manager.guard()
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

func (m *Manager) OwnsProcess() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.process != nil }

// EnableSourceReload watches Python sources and restarts only a process owned
// by this manager. The callback runs before termination so callers can queue a
// safety stop for connected devices.
func (m *Manager) EnableSourceReload(root string, beforeReload func()) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	fingerprint, err := pythonSourceFingerprint(root)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.process == nil {
		return fmt.Errorf("视觉后台不是由控制器启动，无法安全热重载")
	}
	m.reloadDir = root
	m.reloadFingerprint = fingerprint
	m.reloadCandidate = ""
	m.reloadCandidateAt = time.Time{}
	m.beforeReload = beforeReload
	return nil
}

func pythonSourceFingerprint(root string) (string, error) {
	hash := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".venv", "__pycache__", ".git":
				if path != root {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(entry.Name()), ".py") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\n", filepath.ToSlash(relative), info.Size(), info.ModTime().UnixNano())
		return nil
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func (m *Manager) sourceReloadReady(now time.Time) (bool, func(), error) {
	m.mu.Lock()
	root := m.reloadDir
	baseline := m.reloadFingerprint
	candidate := m.reloadCandidate
	candidateAt := m.reloadCandidateAt
	m.mu.Unlock()
	if root == "" {
		return false, nil, nil
	}
	current, err := pythonSourceFingerprint(root)
	if err != nil {
		return false, nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if current == baseline {
		m.reloadCandidate = ""
		m.reloadCandidateAt = time.Time{}
		return false, nil, nil
	}
	if current != candidate {
		m.reloadCandidate = current
		m.reloadCandidateAt = now
		return false, nil, nil
	}
	if now.Sub(candidateAt) < 750*time.Millisecond {
		return false, nil, nil
	}
	m.reloadFingerprint = current
	m.reloadCandidate = ""
	m.reloadCandidateAt = time.Time{}
	return true, m.beforeReload, nil
}

func (m *Manager) restartProcess() (bool, error) {
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return false, nil
	}
	old := m.process
	m.process = nil
	m.mu.Unlock()
	if old != nil {
		response, _ := m.client.Post(m.baseURL+"/stop", "application/json", nil)
		if response != nil {
			response.Body.Close()
		}
		_ = old.Kill()
		_ = old.Wait()
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return false, nil
	}
	m.mu.Unlock()
	process, err := m.start("")
	if err != nil {
		return false, err
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		_ = process.Kill()
		_ = process.Wait()
		return false, nil
	}
	m.process = process
	m.mu.Unlock()
	deadline := time.Now().Add(m.startupTimeout)
	for time.Now().Before(deadline) {
		if m.healthy() {
			return true, nil
		}
		select {
		case <-m.stop:
			return false, nil
		case <-time.After(100 * time.Millisecond):
		}
	}
	return false, nil
}

func (m *Manager) guard() {
	defer close(m.done)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	failures := 0
	restarts := []time.Time{}
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
		}
		if m.healthy() {
			failures = 0
			reload, beforeReload, err := m.sourceReloadReady(time.Now())
			if err != nil {
				log.Printf("vision hot reload: source scan failed: %v", err)
				continue
			}
			if !reload {
				continue
			}
			log.Printf("vision hot reload: Python source changed; stopping devices and restarting backend")
			if beforeReload != nil {
				beforeReload()
			}
			ready, err := m.restartProcess()
			if err != nil {
				log.Printf("vision hot reload: restart failed: %v", err)
				continue
			}
			if ready {
				log.Printf("vision hot reload: backend restored")
			} else {
				log.Printf("vision hot reload: restarted process did not become healthy")
			}
			continue
		}
		failures++
		if failures < m.failureThreshold {
			continue
		}
		now := time.Now()
		kept := restarts[:0]
		for _, value := range restarts {
			if now.Sub(value) < time.Minute {
				kept = append(kept, value)
			}
		}
		restarts = kept
		if len(restarts) >= 5 {
			log.Printf("vision watchdog: crash loop detected; automatic restart paused for 60s")
			select {
			case <-m.stop:
				return
			case <-time.After(time.Minute):
			}
			restarts = nil
		}
		delay := time.Second << min(len(restarts), 4)
		log.Printf("vision watchdog: backend unavailable; restarting in %s", delay)
		select {
		case <-m.stop:
			return
		case <-time.After(delay):
		}
		ready, err := m.restartProcess()
		if err != nil {
			log.Printf("vision watchdog: restart failed: %v", err)
			restarts = append(restarts, time.Now())
			continue
		}
		restarts = append(restarts, time.Now())
		if ready {
			log.Printf("vision watchdog: backend restored")
			failures = 0
		} else {
			log.Printf("vision watchdog: restarted process did not become healthy")
		}
	}
}

func (m *Manager) Close() error {
	m.mu.Lock()
	if !m.closing {
		m.closing = true
		close(m.stop)
	}
	process := m.process
	m.process = nil
	m.mu.Unlock()
	<-m.done
	if process == nil {
		return nil
	}
	response, _ := m.client.Post(m.baseURL+"/stop", "application/json", nil)
	if response != nil {
		response.Body.Close()
	}
	if err := process.Kill(); err != nil {
		return err
	}
	_ = process.Wait()
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
