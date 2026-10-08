package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// ApplyProgramEnvironment makes program.json the default source for runtime
// settings while preserving explicit process environment overrides.
func ApplyProgramEnvironment(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var file struct {
		Environment map[string]string `json:"environment"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return err
	}
	if file.Environment == nil {
		return fmt.Errorf("program.json 缺少 environment 对象")
	}
	for name := range file.Environment {
		if !strings.HasPrefix(name, "FISH_") && !strings.HasPrefix(name, "ROBOFISH_") {
			return fmt.Errorf("program.json 不支持环境变量 %q", name)
		}
	}
	for name, value := range file.Environment {
		if _, exists := os.LookupEnv(name); !exists {
			if err := os.Setenv(name, value); err != nil {
				return err
			}
		}
	}
	return nil
}
