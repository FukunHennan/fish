package visionprocess

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolvePythonPrefersFishPython(t *testing.T) {
	root := t.TempDir()
	python := filepath.Join(root, "custom-python")
	if runtime.GOOS == "windows" {
		python += ".exe"
	}
	if err := os.WriteFile(python, []byte("test"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FISH_PYTHON", python)

	resolved, err := ResolvePython(filepath.Join(root, "vision"))
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Executable != python || resolved.Source != "FISH_PYTHON" {
		t.Fatalf("resolved=%+v", resolved)
	}
}

func TestResolvePythonUsesProjectVenvWhenAvailable(t *testing.T) {
	root := t.TempDir()
	visionDir := filepath.Join(root, "vision")
	var python string
	if runtime.GOOS == "windows" {
		python = filepath.Join(visionDir, ".venv", "Scripts", "python.exe")
	} else {
		python = filepath.Join(visionDir, ".venv", "bin", "python")
	}
	if err := os.MkdirAll(filepath.Dir(python), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(python, []byte("test"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FISH_PYTHON", "")

	resolved, err := ResolvePython(visionDir)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Executable != python || resolved.Source != "project_venv" {
		t.Fatalf("resolved=%+v", resolved)
	}
}

func TestResolvePythonRejectsMissingConfiguredInterpreter(t *testing.T) {
	t.Setenv("FISH_PYTHON", filepath.Join(t.TempDir(), "missing-python"))
	if _, err := ResolvePython(t.TempDir()); err == nil {
		t.Fatal("expected missing FISH_PYTHON to fail explicitly")
	}
}
