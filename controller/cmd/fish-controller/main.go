package main

import (
	"fish-controller/internal/config"
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
	configPath := os.Getenv("FISH_CONFIG")
	if configPath == "" {
		for _, candidate := range []string{filepath.Join("config", "deployment.json"), filepath.Join("..", "config", "deployment.json")} {
			if _, err := os.Stat(candidate); err == nil { configPath = candidate; break }
		}
	}
	cfg, err := config.Load(configPath)
	if err != nil { log.Fatalf("读取部署配置失败：%v", err) }
	visionDir, err := visionprocess.FindDir("vision", filepath.Join("..", "vision"))
	if err != nil { log.Fatalf("定位视觉程序失败：%v", err) }
	visionManager, err := visionprocess.Ensure(
		"http://127.0.0.1:8091",
		visionprocess.PythonStarter(visionDir),
		20*time.Second,
	)
	if err != nil { log.Fatalf("启动视觉后台失败：%v", err) }
	defer visionManager.Close()
	if visionManager.OwnsProcess() { log.Printf("Python 视觉后台已自动启动") } else { log.Printf("复用已运行的 Python 视觉后台") }
	discoveryService := discovery.NewService(cfg.DeploymentKey, func(device discovery.Response) {
		log.Printf("发现已认证机器鱼：%s (%s)", device.DeviceID, device.IP)
	})
	if err := discoveryService.Start(); err != nil { log.Fatal(err) }
	defer discoveryService.Close()
	address := ":8081"
	log.Printf("机器鱼控制器已启动：http://localhost%s", address)
	log.Fatal(http.ListenAndServe(address, webapp.NewHandler(hub.New(), cfg.DeploymentKey)))
}
