package hub

import (
	"sync"
	"time"
)

type Conn interface {
	WriteJSON(any) error
	Close() error
}

type Device struct {
	ID              string    `json:"deviceId"`
	Name            string    `json:"name"`
	IP              string    `json:"ip"`
	FirmwareVersion string    `json:"firmwareVersion"`
	Online          bool      `json:"online"`
	LastSeen        time.Time `json:"lastSeen"`
	Mode            int       `json:"mode"`
	Frequency       float64   `json:"frequency"`
	Amplitude       float64   `json:"amplitude"`
	Bias            float64   `json:"bias"`
	RSSI            int       `json:"rssi"`
	UptimeMs        uint64    `json:"uptimeMs"`
	LastControlMs   uint64    `json:"lastControlMs"`
	StopReason      string    `json:"stopReason"`
}

type entry struct {
	device Device
	conn   Conn
}
type Hub struct {
	mu      sync.RWMutex
	entries map[string]*entry
}

func New() *Hub { return &Hub{entries: make(map[string]*entry)} }

func (h *Hub) Register(d Device, c Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old := h.entries[d.ID]; old != nil && old.conn != nil {
		_ = old.conn.Close()
	}
	d.Online = true
	d.LastSeen = time.Now()
	h.entries[d.ID] = &entry{device: d, conn: c}
}

func (h *Hub) Remove(id string, c Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if e := h.entries[id]; e != nil && e.conn == c {
		delete(h.entries, id)
	}
}

func (h *Hub) Update(id string, values map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.entries[id]
	if e == nil {
		return
	}
	e.device.LastSeen = time.Now()
	if v, ok := values["mode"].(float64); ok {
		e.device.Mode = int(v)
	}
	if v, ok := values["frequency"].(float64); ok {
		e.device.Frequency = v
	}
	if v, ok := values["amplitude"].(float64); ok {
		e.device.Amplitude = v
	}
	if v, ok := values["bias"].(float64); ok {
		e.device.Bias = v
	}
	if v, ok := values["rssi"].(float64); ok {
		e.device.RSSI = int(v)
	}
	if v, ok := values["ip"].(string); ok {
		e.device.IP = v
	}
	if v, ok := values["firmwareVersion"].(string); ok {
		e.device.FirmwareVersion = v
	}
	if v, ok := values["uptimeMs"].(float64); ok && v >= 0 {
		e.device.UptimeMs = uint64(v)
	}
	if v, ok := values["lastControlMs"].(float64); ok && v >= 0 {
		e.device.LastControlMs = uint64(v)
	}
	if v, ok := values["stopReason"].(string); ok {
		e.device.StopReason = v
	}
}

func (h *Hub) Send(id string, v any) bool {
	h.mu.RLock()
	e := h.entries[id]
	h.mu.RUnlock()
	if e == nil || e.conn == nil {
		return false
	}
	return e.conn.WriteJSON(v) == nil
}

func (h *Hub) SendOnly(v any) bool {
	h.mu.RLock()
	if len(h.entries) != 1 {
		h.mu.RUnlock()
		return false
	}
	var connection Conn
	for _, entry := range h.entries { connection = entry.conn }
	h.mu.RUnlock()
	return connection != nil && connection.WriteJSON(v) == nil
}

func (h *Hub) List() []Device {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]Device, 0, len(h.entries))
	for _, e := range h.entries {
		out = append(out, e.device)
	}
	return out
}
