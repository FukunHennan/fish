package main

import (
	"fish-controller/internal/config"
	"fish-controller/internal/diagnostics"
	"fish-controller/internal/discovery"
	"fish-controller/internal/hub"
	"fish-controller/internal/visionprocess"
	webapp "fish-controller/internal/web"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	diagnosticRoot := os.Getenv("FISH_DIAGNOSTIC_DIR")
	diag, err := diagnostics.New(diagnosticRoot)
	if err != nil {
		log.Fatalf("初始化诊断日志失败：%v", err)
	}
	defer diag.Close()
	log.Printf("诊断日志会话：%s", diag.Dir)
	diag.Logger.Info("controller_starting")

	configPath := os.Getenv("FISH_CONFIG")
	if configPath == "" {
		for _, candidate := range []string{filepath.Join("config", "deployment.json"), filepath.Join("..", "config", "deployment.json")} {
			if _, statErr := os.Stat(candidate); statErr == nil {
				configPath = candidate
				break
			}
		}
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		diag.Logger.Error("config_load_failed", "path", configPath, "error", err)
		log.Fatalf("读取部署配置失败：%v", err)
	}
	diag.Logger.Info("config_loaded", "path", configPath)

	visionDir, err := visionprocess.FindDir("vision", filepath.Join("..", "vision"))
	if err != nil {
		diag.Logger.Error("vision_dir_not_found", "error", err)
		log.Fatalf("定位视觉程序失败：%v", err)
	}
	diag.Logger.Info("vision_dir_found", "path", visionDir)

	visionStart := time.Now()
	visionManager, err := visionprocess.Ensure(
		"http://127.0.0.1:8091",
		visionprocess.PythonStarterWithOutput(visionDir, diag.PythonWriter(), diag.PythonWriter()),
		20*time.Second,
	)
	if err != nil {
		diag.Logger.Error("vision_backend_start_failed", "duration_ms", time.Since(visionStart).Milliseconds(), "error", err)
		log.Fatalf("启动视觉后台失败：%v", err)
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
		log.Printf("Python 视觉后台已自动启动")
		diag.Logger.Info("vision_backend_ready", "mode", "started", "duration_ms", time.Since(visionStart).Milliseconds())
	} else {
		log.Printf("复用已运行的 Python 视觉后台")
		diag.Logger.Info("vision_backend_ready", "mode", "reused", "duration_ms", time.Since(visionStart).Milliseconds())
	}

	discoveryService := discovery.NewService(cfg.DeploymentKey, func(device discovery.Response) {
		log.Printf("发现已认证机器鱼：%s (%s)", device.DeviceID, device.IP)
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
	log.Printf("机器鱼控制器已启动：http://localhost%s", address)
	diag.Logger.Info("controller_ready", "address", address)
	if err := http.ListenAndServe(address, handler); err != nil {
		diag.Logger.Error("http_server_stopped", "error", err)
		log.Fatal(err)
	}
}
