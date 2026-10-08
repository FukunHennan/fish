package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestApplyProgramEnvironmentPreservesProcessOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "program.json")
	if err := os.WriteFile(path, []byte(`{"environment":{"FISH_CAMERA_INDEX":"1","FISH_CAPTURE_WIDTH":"640"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FISH_CAMERA_INDEX", "2")
	previous, existed := os.LookupEnv("FISH_CAPTURE_WIDTH")
	_ = os.Unsetenv("FISH_CAPTURE_WIDTH")
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv("FISH_CAPTURE_WIDTH", previous)
		} else {
			_ = os.Unsetenv("FISH_CAPTURE_WIDTH")
		}
	})
	if err := ApplyProgramEnvironment(path); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("FISH_CAMERA_INDEX"); got != "2" {
		t.Fatalf("process override lost: %q", got)
	}
	if got := os.Getenv("FISH_CAPTURE_WIDTH"); got != "640" {
		t.Fatalf("program default missing: %q", got)
	}
}
