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
	device Device
	conn   Conn

	outboundMu      sync.Mutex
	outbound        []*outboundMessage
	latestPending   *outboundMessage
	latestSequence  uint64
	nextOrder       uint64
	outboundWake    chan struct{}
	outboundStopped bool
	visionDeadline  time.Time
	visionSession   string

	stop     chan struct{}
	stopOnce sync.Once
}

type outboundMessage struct {
	value         any
	order         uint64
	done          chan error
	latest        bool
	motionExpires time.Time
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
		device:       d,
		conn:         c,
		outboundWake: make(chan struct{}, 1),
		stop:         make(chan struct{}),
	}
	h.entries[d.ID] = current
	go current.writeOutboundLoop()
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
	return h.sendWithMotionTimeout(id, v, 0)
}

func (h *Hub) sendWithMotionTimeout(id string, v any, lifetime time.Duration) bool {
	e := h.entry(id)
	if e == nil {
		return false
	}
	done := make(chan error, 1)
	if !e.enqueueWithMotionTimeout(v, done, lifetime) {
		return false
	}
	return <-done == nil
}

// SendLatest queues a low-latency state update. If the device writer is busy,
// an older update is replaced by the newest one.
func (h *Hub) SendLatest(id string, v any) bool {
	return h.SendLatestOrdered(id, 0, v)
}

// SendLatestOrdered queues a low-latency state update and drops an older
// sequence that arrived late. Sequence zero keeps the legacy unordered mode.
func (h *Hub) SendLatestOrdered(id string, sequence uint64, v any) bool {
	e := h.entry(id)
	if e == nil {
		return false
	}
	if !e.enqueueLatest(sequence, v) {
		return false
	}
	select {
	case e.outboundWake <- struct{}{}:
	default:
	}
	return true
}

func (h *Hub) SendLatestStop(id string, sequence uint64, v any) bool {
	e := h.entry(id)
	if e == nil {
		return false
	}
	if !e.enqueueLatestFrame(sequence, v, true) {
		return false
	}
	select {
	case e.outboundWake <- struct{}{}:
	default:
	}
	return true
}

func (e *entry) stopWriter() {
	e.stopOnce.Do(func() {
		e.outboundMu.Lock()
		e.outboundStopped = true
		pending := append([]*outboundMessage(nil), e.outbound...)
		e.outbound = nil
		e.latestPending = nil
		e.outboundMu.Unlock()
		for _, message := range pending {
			completeOutbound(message, ErrConnectionClosed)
		}
		close(e.stop)
	})
}

func (e *entry) writeOutboundLoop() {
	for {
		select {
		case <-e.outboundWake:
			for {
				message := e.popNext()
				if message == nil {
					break
				}
				err := e.conn.WriteJSON(message.value)
				completeOutbound(message, err)
				if err != nil {
					e.stopWriter()
					_ = e.conn.Close()
					return
				}
			}
		case <-e.stop:
			return
		}
	}
}

var ErrConnectionClosed = &connectionClosedError{}

type connectionClosedError struct{}

func (*connectionClosedError) Error() string { return "device connection closed" }

func completeOutbound(message *outboundMessage, err error) {
	if message == nil || message.done == nil {
		return
	}
	message.done <- err
}

func (e *entry) enqueue(value any, done chan error) bool {
	return e.enqueueWithMotionTimeout(value, done, 0)
}

func (e *entry) enqueueWithMotionTimeout(value any, done chan error, lifetime time.Duration) bool {
	return e.enqueueVision(value, done, lifetime, "", "")
}

func (e *entry) enqueueVision(value any, done chan error, lifetime time.Duration, session, operation string) bool {
	e.outboundMu.Lock()
	defer e.outboundMu.Unlock()
	if e.outboundStopped {
		return false
	}
	if operation != "" && operation != "start" {
		if session == "" || session != e.visionSession || (!e.visionDeadline.IsZero() && !time.Now().Before(e.visionDeadline)) {
			return false
		}
	}
	if operation == "start" || (lifetime == 0 && replacesMotion(value)) {
		e.invalidateVisionLocked()
	}
	if operation == "start" {
		e.visionSession = session
	}
	e.nextOrder++
	var expires time.Time
	if lifetime > 0 {
		expires = time.Now().Add(lifetime)
		e.visionDeadline = expires
	} else if replacesMotion(value) {
		e.visionDeadline = time.Time{}
	}
	e.outbound = append(e.outbound, &outboundMessage{
		value:         value,
		order:         e.nextOrder,
		done:          done,
		motionExpires: expires,
	})
	select {
	case e.outboundWake <- struct{}{}:
	default:
	}
	return true
}

func (e *entry) enqueueLatest(sequence uint64, value any) bool {
	return e.enqueueLatestFrame(sequence, value, false)
}

func (e *entry) enqueueLatestFrame(sequence uint64, value any, stop bool) bool {
	e.outboundMu.Lock()
	defer e.outboundMu.Unlock()
	if e.outboundStopped {
		return false
	}
	if !stop && sequence > 0 && sequence <= e.latestSequence {
		return false
	}
	if sequence > e.latestSequence {
		e.latestSequence = sequence
	}
	if replacesMotion(value) {
		e.invalidateVisionLocked()
	}
	e.nextOrder++
	if e.latestPending != nil {
		e.latestPending.value = value
		e.latestPending.order = e.nextOrder
		e.latestPending.latest = true
	} else {
		e.latestPending = &outboundMessage{
			value:  value,
			order:  e.nextOrder,
			latest: true,
		}
		e.outbound = append(e.outbound, e.latestPending)
	}
	return true
}

func (e *entry) popNext() *outboundMessage {
	e.outboundMu.Lock()
	defer e.outboundMu.Unlock()
	e.dropExpiredMotionLocked(time.Now())
	if len(e.outbound) == 0 {
		return nil
	}
	index := 0
	for i := 1; i < len(e.outbound); i++ {
		if e.outbound[i].order < e.outbound[index].order {
			index = i
		}
	}
	message := e.outbound[index]
	e.outbound = append(e.outbound[:index], e.outbound[index+1:]...)
	if message == e.latestPending {
		e.latestPending = nil
	}
	return message
}

func (h *Hub) entry(id string) *entry {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.entries[id]
}

// SendAndWait routes a command and waits for the matching device result.
// The waiter is installed before the write so an immediate reply cannot be missed.
func (h *Hub) SendAndWait(id, requestID string, v any, timeout time.Duration) (map[string]any, bool, bool) {
	return h.SendAndWaitWithMotionTimeout(id, requestID, v, timeout, 0)
}

// SendAndWaitWithMotionTimeout arms a motion deadline before queueing, even if
// the device ACK is subsequently lost. A zero lifetime preserves normal sends.
func (h *Hub) SendAndWaitWithMotionTimeout(id, requestID string, v any, timeout, lifetime time.Duration) (map[string]any, bool, bool) {
	return h.QueueCommand(id, requestID, v, lifetime).Wait(timeout)
}

// Receipt separates atomic admission/queueing from potentially slow network I/O.
type Receipt struct {
	h         *Hub
	requestID string
	written   chan error
	result    chan map[string]any
	queued    bool
}

func (h *Hub) QueueCommand(id, requestID string, value any, lifetime time.Duration) *Receipt {
	return h.QueueVisionCommand(id, requestID, value, lifetime, "", "")
}

func (h *Hub) QueueVisionCommand(id, requestID string, value any, lifetime time.Duration, session, operation string) *Receipt {
	r := &Receipt{h: h, requestID: requestID, written: make(chan error, 1), result: make(chan map[string]any, 1)}
	h.mu.Lock()
	h.pending[requestID] = r.result
	e := h.entries[id]
	h.mu.Unlock()
	r.queued = e != nil && e.enqueueVision(value, r.written, lifetime, session, operation)
	return r
}

func (r *Receipt) Queued() bool { return r.queued }

func (r *Receipt) Wait(timeout time.Duration) (map[string]any, bool, bool) {
	defer func() { r.h.mu.Lock(); delete(r.h.pending, r.requestID); r.h.mu.Unlock() }()
	if !r.queued {
		return nil, false, false
	}
	if <-r.written != nil {
		return nil, false, false
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case ack := <-r.result:
		return ack, true, true
	case <-timer.C:
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
	var id string
	for _, entry := range h.entries {
		id = entry.device.ID
	}
	h.mu.RUnlock()
	return id != "" && h.Send(id, v)
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

// RemoveInactive removes devices that have not sent a message within maxAge.
// Device connections are closed outside the Hub lock so a slow WebSocket
// implementation cannot block dashboard reads or other device registrations.
func (h *Hub) RemoveInactive(maxAge time.Duration) []string {
	cutoff := time.Now().Add(-maxAge)
	type staleEntry struct {
		id string
		e  *entry
	}
	var stale []staleEntry

	h.mu.Lock()
	for id, e := range h.entries {
		if e == nil || e.device.LastSeen.After(cutoff) {
			continue
		}
		delete(h.entries, id)
		e.stopWriter()
		stale = append(stale, staleEntry{id: id, e: e})
	}
	if len(stale) > 0 {
		h.notifyLocked()
	}
	h.mu.Unlock()

	ids := make([]string, 0, len(stale))
	for _, item := range stale {
		ids = append(ids, item.id)
		if item.e != nil && item.e.conn != nil {
			_ = item.e.conn.Close()
		}
	}
	return ids
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
