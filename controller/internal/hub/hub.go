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
	ID                 string    `json:"deviceId"`
	Name               string    `json:"name"`
	IP                 string    `json:"ip"`
	FirmwareVersion    string    `json:"firmwareVersion"`
	Online             bool      `json:"online"`
	LastSeen           time.Time `json:"lastSeen"`
	Mode               int       `json:"mode"`
	Frequency          float64   `json:"frequency"`
	Amplitude          float64   `json:"amplitude"`
	Bias               float64   `json:"bias"`
	RSSI               int       `json:"rssi"`
	UptimeMs           uint64    `json:"uptimeMs"`
	LastControlMs      uint64    `json:"lastControlMs"`
	StopReason         string    `json:"stopReason"`
	BatteryVoltage     float64   `json:"batteryVoltage"`
	BatteryPercent     int       `json:"batteryPercent"`
	BatterySampleAgeMs uint64    `json:"batterySampleAgeMs"`
	Capabilities       []string  `json:"capabilities,omitempty"`
	ControlSource      string    `json:"controlSource"`
	VisionActive       bool      `json:"visionActive"`
	VisionSessionID    string    `json:"visionSessionId"`
	VisionSequence     uint32    `json:"visionSequence"`
	OTAState           string    `json:"otaState"`
	LightSensorOnline  bool      `json:"lightSensorOnline"`
	IlluminanceLux     float64   `json:"illuminanceLux"`
	I2CAddresses       []int     `json:"i2cAddresses,omitempty"`
	RGBMode            string    `json:"rgbMode"`
	RGBOrder           string    `json:"rgbOrder"`
	RGBRed             int       `json:"rgbRed"`
	RGBGreen           int       `json:"rgbGreen"`
	RGBBlue            int       `json:"rgbBlue"`
	RGBBrightness      int       `json:"rgbBrightness"`
}

type entry struct {
	device Device
	conn   Conn
}
type Hub struct {
	mu      sync.RWMutex
	entries map[string]*entry
	pending map[string]chan map[string]any
}

func New() *Hub {
	return &Hub{entries: make(map[string]*entry), pending: make(map[string]chan map[string]any)}
}

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
	if v, ok := values["batteryVoltage"].(float64); ok && v >= 0 {
		e.device.BatteryVoltage = v
	}
	if v, ok := values["batteryPercent"].(float64); ok && v >= 0 && v <= 100 {
		e.device.BatteryPercent = int(v)
	}
	if v, ok := values["batterySampleAgeMs"].(float64); ok && v >= 0 {
		e.device.BatterySampleAgeMs = uint64(v)
	}
	if v, ok := values["controlSource"].(string); ok {
		e.device.ControlSource = v
	}
	if v, ok := values["visionActive"].(bool); ok {
		e.device.VisionActive = v
	}
	if v, ok := values["visionSessionId"].(string); ok {
		e.device.VisionSessionID = v
	}
	if v, ok := values["visionSequence"].(float64); ok && v >= 0 {
		e.device.VisionSequence = uint32(v)
	}
	if v, ok := values["otaState"].(string); ok {
		e.device.OTAState = v
	}
	if v, ok := values["lightSensorOnline"].(bool); ok {
		e.device.LightSensorOnline = v
	}
	if v, ok := values["illuminanceLux"].(float64); ok && v >= 0 {
		e.device.IlluminanceLux = v
	}
	if values, ok := values["i2cAddresses"].([]any); ok {
		e.device.I2CAddresses = e.device.I2CAddresses[:0]
		for _, value := range values {
			if address, ok := value.(float64); ok && address > 0 && address < 127 {
				e.device.I2CAddresses = append(e.device.I2CAddresses, int(address))
			}
		}
	}
	if v, ok := values["rgbMode"].(string); ok {
		e.device.RGBMode = v
	}
	if v, ok := values["rgbOrder"].(string); ok {
		e.device.RGBOrder = v
	}
	if v, ok := values["rgbRed"].(float64); ok {
		e.device.RGBRed = int(v)
	}
	if v, ok := values["rgbGreen"].(float64); ok {
		e.device.RGBGreen = int(v)
	}
	if v, ok := values["rgbBlue"].(float64); ok {
		e.device.RGBBlue = int(v)
	}
	if v, ok := values["rgbBrightness"].(float64); ok {
		e.device.RGBBrightness = int(v)
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

// SendAndWait routes a command and waits for the matching device result.
// The waiter is installed before the write so an immediate reply cannot be missed.
func (h *Hub) SendAndWait(id, requestID string, v any, timeout time.Duration) (map[string]any, bool, bool) {
	result := make(chan map[string]any, 1)
	h.mu.Lock()
	h.pending[requestID] = result
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, requestID)
		h.mu.Unlock()
	}()
	if !h.Send(id, v) {
		return nil, false, false
	}
	select {
	case acknowledgement := <-result:
		return acknowledgement, true, true
	case <-time.After(timeout):
		return nil, true, false
	}
}

func (h *Hub) ResolveCommandResult(values map[string]any) bool {
	requestID, _ := values["requestId"].(string)
	if requestID == "" {
		return false
	}
	h.mu.RLock()
	waiter := h.pending[requestID]
	h.mu.RUnlock()
	if waiter == nil {
		return false
	}
	select {
	case waiter <- values:
		return true
	default:
		return false
	}
}

func (h *Hub) SendOnly(v any) bool {
	h.mu.RLock()
	if len(h.entries) != 1 {
		h.mu.RUnlock()
		return false
	}
	var connection Conn
	for _, entry := range h.entries {
		connection = entry.conn
	}
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
