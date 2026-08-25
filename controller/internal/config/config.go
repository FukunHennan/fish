package config

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
)

type Config struct {
	DeploymentKey []byte
}

func Load(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var file struct {
		DeploymentKey string `json:"deploymentKey"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return Config{}, err
	}
	key, err := hex.DecodeString(file.DeploymentKey)
	if err != nil || len(key) != 32 {
		return Config{}, errors.New("deploymentKey 必须是 32 字节十六进制")
	}
	return Config{DeploymentKey: key}, nil
}
