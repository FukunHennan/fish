package main

import (
	"crypto/sha256"
	"fish-controller/internal/config"
	"fish-controller/internal/diagnostics"
	"fish-controller/internal/discovery"
	"fish-controller/internal/hub"
	"fish-controller/internal/visionprocess"
	webapp "fish-controller/internal/web"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func findProjectRoot() (string, error) {
	for _, candidate := range []string{".", ".."} {
		root, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		visionInfo, visionErr := os.Stat(filepath.Join(root, "vision", "server.py"))
		controllerInfo, controllerErr := os.Stat(filepath.Join(root, "controller", "go.mod"))
		if visionErr == nil && controllerErr == nil && !visionInfo.IsDir() && !controllerInfo.IsDir() {
			return root, nil
		}
	}
	return "", fmt.Errorf("无法定位项目根目录；请从 fish 或 fish/controller 目录启动")
}

func main() {
	projectRoot, err := findProjectRoot()
	if err != nil {
		log.Fatal(err)
	}

	diagnosticRoot := os.Getenv("FISH_DIAGNOSTIC_DIR")
	if diagnosticRoot == "" {
		diagnosticRoot = filepath.Join(projectRoot, "controller", "diagnostics", "runs")
	}
	diag, err := diagnostics.New(diagnosticRoot)
	if err != nil {
		log.Fatalf("failed to initialize diagnostics: %v", err)
	}
	defer diag.Close()
	log.Printf("project root: %s", projectRoot)
	log.Printf("diagnostic session: %s", diag.Dir)
	diag.Logger.Info("controller_starting", "project_root", projectRoot)

	configPath := os.Getenv("FISH_CONFIG")
	if configPath == "" {
		configPath = filepath.Join(projectRoot, "config", "deployment.json")
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		diag.Logger.Error("config_load_failed", "path", configPath, "error", err)
		log.Fatalf("failed to load deployment config: %v", err)
	}
	diag.Logger.Info("config_loaded", "path", configPath)

	visionDir := filepath.Join(projectRoot, "vision")
	if _, err := visionprocess.FindDir(visionDir); err != nil {
		diag.Logger.Error("vision_dir_not_found", "path", visionDir, "error", err)
		log.Fatalf("failed to locate vision service: %v", err)
	}
	diag.Logger.Info("vision_dir_found", "path", visionDir)
	python, err := visionprocess.ResolvePython(visionDir)
	if err != nil {
		diag.Logger.Error("python_not_found", "error", err)
		log.Fatalf("Python environment unavailable: %v", err)
	}
	log.Printf("vision Python: %s (%s)", python.Executable, python.Source)
	diag.Logger.Info("python_resolved", "executable", python.Executable, "source", python.Source)
	token := sha256.Sum256(append([]byte("fish-vision-internal-v1\n"), cfg.DeploymentKey...))
	if os.Getenv("FISH_VISION_INTERNAL_TOKEN") == "" {
		_ = os.Setenv("FISH_VISION_INTERNAL_TOKEN", fmt.Sprintf("%x", token))
	}

	visionStart := time.Now()
	visionManager, err := visionprocess.Ensure(
		"http://127.0.0.1:8091",
		visionprocess.PythonStarterWithOutput(visionDir, diag.PythonWriter(), diag.PythonWriter()),
		20*time.Second,
	)
	if err != nil {
		diag.Logger.Error("vision_backend_start_failed", "duration_ms", time.Since(visionStart).Milliseconds(), "error", err)
		log.Fatalf("failed to start vision backend: %v", err)
	}
	defer func() {
		started := time.Now()
		if err := visionManager.Close(); err != nil {
			diag.Logger.Error("vision_backend_close_failed", "duration_ms", time.Since(started).Milliseconds(), "error", err)
			return
		}
		diag.Logger.Info("vision_backend_closed", "duration_ms", time.Since(started).Milliseconds())
	}()
	if visionManager.OwnsProcess() {
		log.Printf("Python vision backend started automatically")
		diag.Logger.Info("vision_backend_ready", "mode", "started", "duration_ms", time.Since(visionStart).Milliseconds())
	} else {
		log.Printf("reusing running Python vision backend")
		diag.Logger.Info("vision_backend_ready", "mode", "reused", "duration_ms", time.Since(visionStart).Milliseconds())
	}

	discoveryService := discovery.NewService(cfg.DeploymentKey, func(device discovery.Response) {
		log.Printf("authenticated fish discovered: %s (%s)", device.DeviceID, device.IP)
		diag.Logger.Info("device_discovered", "device_id", device.DeviceID, "ip", device.IP)
	})
	if err := discoveryService.Start(); err != nil {
		diag.Logger.Error("discovery_start_failed", "error", err)
		log.Fatal(err)
	}
	defer discoveryService.Close()
	diag.Logger.Info("discovery_started")

	address := ":8081"
	handler := diag.HTTPMiddleware(webapp.NewHandler(hub.New(), cfg.DeploymentKey))
	log.Printf("fish controller ready: http://localhost%s", address)
	diag.Logger.Info("controller_ready", "address", address)
	if err := http.ListenAndServe(address, handler); err != nil {
		diag.Logger.Error("http_server_stopped", "error", err)
		log.Fatal(err)
	}
}
