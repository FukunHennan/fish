package hub

import (
	"reflect"
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
	device         Device
	conn           Conn
	latestMu       sync.Mutex
	latest         any
	latestSequence uint64
	latestWake     chan struct{}
	stop           chan struct{}
	stopOnce       sync.Once
}
type Hub struct {
	mu          sync.RWMutex
	entries     map[string]*entry
	order       []string
	pending     map[string]chan map[string]any
	subscribers map[chan struct{}]struct{}
}

func New() *Hub {
	return &Hub{
		entries:     make(map[string]*entry),
		pending:     make(map[string]chan map[string]any),
		subscribers: make(map[chan struct{}]struct{}),
	}
}

func (h *Hub) Register(d Device, c Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old := h.entries[d.ID]; old != nil && old.conn != nil {
		old.stopWriter()
		_ = old.conn.Close()
	}
	if !containsDeviceID(h.order, d.ID) {
		h.order = append(h.order, d.ID)
	}
	d.Online = true
	d.LastSeen = time.Now()
	current := &entry{
		device: d, conn: c,
		latestWake: make(chan struct{}, 1),
		stop:       make(chan struct{}),
	}
	h.entries[d.ID] = current
	go current.writeLatestLoop()
	h.notifyLocked()
}

func (h *Hub) Remove(id string, c Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if e := h.entries[id]; e != nil && e.conn == c {
		e.stopWriter()
		delete(h.entries, id)
		h.notifyLocked()
	}
}

func (h *Hub) Update(id string, values map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.entries[id]
	if e == nil {
		return
	}
	before := deviceDisplaySignature(e.device)
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
	if !reflect.DeepEqual(before, deviceDisplaySignature(e.device)) {
		h.notifyLocked()
	}
}

// Subscribe returns a coalescing signal channel for dashboard state changes.
// Consumers should call the returned unsubscribe function when the request ends.
func (h *Hub) Subscribe() (<-chan struct{}, func()) {
	updates := make(chan struct{}, 1)
	h.mu.Lock()
	h.subscribers[updates] = struct{}{}
	h.mu.Unlock()
	return updates, func() {
		h.mu.Lock()
		if _, ok := h.subscribers[updates]; ok {
			delete(h.subscribers, updates)
			close(updates)
		}
		h.mu.Unlock()
	}
}

// Notify wakes dashboard subscribers after state outside the Hub changes.
func (h *Hub) Notify() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.notifyLocked()
}

func (h *Hub) notifyLocked() {
	for updates := range h.subscribers {
		select {
		case updates <- struct{}{}:
		default:
		}
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

// SendLatest queues a low-latency state update. If the device writer is busy,
// an older update is replaced by the newest one.
func (h *Hub) SendLatest(id string, v any) bool {
	return h.SendLatestOrdered(id, 0, v)
}

// SendLatestOrdered queues a low-latency state update and drops an older
// sequence that arrived late. Sequence zero keeps the legacy unordered mode.
func (h *Hub) SendLatestOrdered(id string, sequence uint64, v any) bool {
	h.mu.RLock()
	e := h.entries[id]
	h.mu.RUnlock()
	if e == nil || e.conn == nil {
		return false
	}
	e.latestMu.Lock()
	if sequence > 0 && sequence <= e.latestSequence {
		e.latestMu.Unlock()
		return false
	}
	e.latest = v
	if sequence > 0 {
		e.latestSequence = sequence
	}
	e.latestMu.Unlock()
	select {
	case e.latestWake <- struct{}{}:
	default:
	}
	return true
}

func (e *entry) stopWriter() {
	e.stopOnce.Do(func() { close(e.stop) })
}

func (e *entry) writeLatestLoop() {
	for {
		select {
		case <-e.latestWake:
			for {
				e.latestMu.Lock()
				message := e.latest
				e.latest = nil
				e.latestMu.Unlock()
				if message == nil {
					break
				}
				if e.conn.WriteJSON(message) != nil {
					return
				}
			}
		case <-e.stop:
			return
		}
	}
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

// OnlyDeviceID returns the device ID only when exactly one device is connected.
// Vision control currently targets a single fish, so ambiguity must fail closed.
func (h *Hub) OnlyDeviceID() (string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if len(h.entries) != 1 {
		return "", false
	}
	for id, entry := range h.entries {
		if entry != nil && entry.conn != nil {
			return id, true
		}
	}
	return "", false
}

func (h *Hub) List() []Device {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]Device, 0, len(h.entries))
	for _, id := range h.order {
		if e := h.entries[id]; e != nil {
			out = append(out, cloneDevice(e.device))
		}
	}
	return out
}

func cloneDevice(device Device) Device {
	device.Capabilities = append([]string(nil), device.Capabilities...)
	device.I2CAddresses = append([]int(nil), device.I2CAddresses...)
	return device
}

func containsDeviceID(order []string, id string) bool {
	for _, deviceID := range order {
		if deviceID == id {
			return true
		}
	}
	return false
}

type deviceDisplayState struct {
	ID                string
	Name              string
	IP                string
	FirmwareVersion   string
	Online            bool
	Mode              int
	Frequency         float64
	Amplitude         float64
	Bias              float64
	StopReason        string
	BatteryVoltage    float64
	BatteryPercent    int
	Capabilities      []string
	ControlSource     string
	VisionActive      bool
	VisionSessionID   string
	OTAState          string
	LightSensorOnline bool
	IlluminanceLux    float64
	I2CAddresses      []int
	RGBMode           string
	RGBOrder          string
	RGBRed            int
	RGBGreen          int
	RGBBlue           int
	RGBBrightness     int
}

func deviceDisplaySignature(device Device) deviceDisplayState {
	return deviceDisplayState{
		ID:                device.ID,
		Name:              device.Name,
		IP:                device.IP,
		FirmwareVersion:   device.FirmwareVersion,
		Online:            device.Online,
		Mode:              device.Mode,
		Frequency:         device.Frequency,
		Amplitude:         device.Amplitude,
		Bias:              device.Bias,
		StopReason:        device.StopReason,
		BatteryVoltage:    device.BatteryVoltage,
		BatteryPercent:    device.BatteryPercent,
		Capabilities:      append([]string(nil), device.Capabilities...),
		ControlSource:     device.ControlSource,
		VisionActive:      device.VisionActive,
		VisionSessionID:   device.VisionSessionID,
		OTAState:          device.OTAState,
		LightSensorOnline: device.LightSensorOnline,
		IlluminanceLux:    device.IlluminanceLux,
		I2CAddresses:      append([]int(nil), device.I2CAddresses...),
		RGBMode:           device.RGBMode,
		RGBOrder:          device.RGBOrder,
		RGBRed:            device.RGBRed,
		RGBGreen:          device.RGBGreen,
		RGBBlue:           device.RGBBlue,
		RGBBrightness:     device.RGBBrightness,
	}
}
