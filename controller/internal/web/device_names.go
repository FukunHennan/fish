package web

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type deviceNameStore struct {
	mu    sync.RWMutex
	path  string
	Names map[string]string `json:"names"`
}

func newDeviceNameStore(path string) *deviceNameStore {
	store := &deviceNameStore{path: path, Names: map[string]string{}}
	if data, err := os.ReadFile(path); err == nil {
		var wrapped struct {
			Names map[string]string `json:"names"`
		}
		if json.Unmarshal(data, &wrapped) == nil && len(wrapped.Names) > 0 {
			for id, name := range wrapped.Names {
				store.setMemory(id, name)
			}
			return store
		}
		var legacy map[string]string
		if json.Unmarshal(data, &legacy) == nil {
			for id, name := range legacy {
				store.setMemory(id, name)
			}
		}
	}
	return store
}

func deviceNamesPath() string {
	if path := strings.TrimSpace(os.Getenv("FISH_DEVICE_NAMES")); path != "" {
		return path
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "fish-controller", "device-names.json")
}

func normalizeDeviceNameID(deviceID string) string {
	return strings.ToUpper(strings.TrimSpace(deviceID))
}

func normalizeDeviceDisplayName(name string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(name)), " ")
}

func (d *deviceNameStore) setMemory(deviceID, name string) {
	deviceID = normalizeDeviceNameID(deviceID)
	name = normalizeDeviceDisplayName(name)
	if deviceID == "" || name == "" || strings.EqualFold(deviceID, name) {
		delete(d.Names, deviceID)
		return
	}
	d.Names[deviceID] = name
}

func (d *deviceNameStore) Name(deviceID, fallback string) string {
	if d == nil {
		fallback = strings.TrimSpace(fallback)
		if fallback != "" {
			return fallback
		}
		return strings.TrimSpace(deviceID)
	}
	key := normalizeDeviceNameID(deviceID)
	d.mu.RLock()
	name := d.Names[key]
	d.mu.RUnlock()
	if name != "" {
		return name
	}
	fallback = strings.TrimSpace(fallback)
	if fallback != "" {
		return fallback
	}
	return strings.TrimSpace(deviceID)
}

func (d *deviceNameStore) Set(deviceID, name string) (string, error) {
	if d == nil {
		return normalizeDeviceDisplayName(name), nil
	}
	deviceID = normalizeDeviceNameID(deviceID)
	if deviceID == "" {
		return "", os.ErrInvalid
	}
	d.mu.Lock()
	d.setMemory(deviceID, name)
	stored := d.Names[deviceID]
	err := d.saveLocked()
	d.mu.Unlock()
	if stored != "" {
		return stored, err
	}
	return deviceID, err
}

func (d *deviceNameStore) saveLocked() error {
	if d.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	temporary := d.path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, d.path)
}
