package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "deployment.json")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadDeploymentKey(t *testing.T) {
	path := writeConfig(t, `{"deploymentKey":"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"}`)
	cfg, err := Load(path)
	if err != nil || len(cfg.DeploymentKey) != 32 {
		t.Fatalf("配置读取失败: %v", err)
	}
}

func TestRejectsInvalidDeploymentKey(t *testing.T) {
	path := writeConfig(t, `{"deploymentKey":"abcd"}`)
	if _, err := Load(path); err == nil {
		t.Fatal("短密钥必须被拒绝")
	}
}
