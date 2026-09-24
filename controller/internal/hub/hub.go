package hub

import (
	"math"
	"reflect"
	"strings"
	"sync"
	"time"
)

type Conn interface {
	WriteJSON(any) error
	Close() error
}

type Device struct {
	ID                   string    `json:"deviceId"`
	Name                 string    `json:"name"`
	IP                   string    `json:"ip"`
	FirmwareVersion      string    `json:"firmwareVersion"`
	ProtocolVersion      int       `json:"protocolVersion"`
	BootID               string    `json:"bootId,omitempty"`
	Online               bool      `json:"online"`
	LastSeen             time.Time `json:"lastSeen"`
	Mode                 int       `json:"mode"`
	Frequency            float64   `json:"frequency"`
	Amplitude            float64   `json:"amplitude"`
	Bias                 float64   `json:"bias"`
	RSSI                 int       `json:"rssi"`
	UptimeMs             uint64    `json:"uptimeMs"`
	LastControlMs        uint64    `json:"lastControlMs"`
	StopReason           string    `json:"stopReason"`
	BatteryVoltage       float64   `json:"batteryVoltage"`
	BatteryPercent       int       `json:"batteryPercent"`
	HeartbeatRTTMs       float64   `json:"heartbeatRttMs,omitempty"`
	Capabilities         []string  `json:"capabilities,omitempty"`
	Sensors              []string  `json:"sensors,omitempty"`
	ServoPin             int       `json:"servoPin,omitempty"`
	StatusLedPin         int       `json:"statusLedPin,omitempty"`
	BatterySensePin      int       `json:"batterySensePin,omitempty"`
	BatteryDividerRatio  float64   `json:"batteryDividerRatio,omitempty"`
	BatteryEmptyVoltage  float64   `json:"batteryEmptyVoltage,omitempty"`
	BatteryFullVoltage   float64   `json:"batteryFullVoltage,omitempty"`
	ControlSource        string    `json:"controlSource"`
	VisionActive         bool      `json:"visionActive"`
	VisionSessionID      string    `json:"visionSessionId"`
	VisionSequence       uint32    `json:"visionSequence"`
	OTAState             string    `json:"otaState"`
	OTAProgress          int       `json:"otaProgress"`
	LightSensorOnline    bool      `json:"lightSensorOnline"`
	IlluminanceLux       float64   `json:"illuminanceLux"`
	I2CAddresses         []int     `json:"i2cAddresses,omitempty"`
	RGBMode              string    `json:"rgbMode"`
	RGBOrder             string    `json:"rgbOrder"`
	RGBRed               int       `json:"rgbRed"`
	RGBGreen             int       `json:"rgbGreen"`
	RGBBlue              int       `json:"rgbBlue"`
	RGBBrightness        int       `json:"rgbBrightness"`
	ServoCenter          float64   `json:"servoCenter"`
	LastCommandRequestID string    `json:"lastCommandRequestId,omitempty"`
	LastCommandAcked     bool      `json:"lastCommandAcked"`
	LastCommandSuccess   bool      `json:"lastCommandSuccess"`
	LastCommandCode      string    `json:"lastCommandCode,omitempty"`
	LastCommandMessage   string    `json:"lastCommandMessage,omitempty"`
	CommandAckAtMs       int64     `json:"commandAckAtMs,omitempty"`
	HeartbeatAtMs        int64     `json:"heartbeatAtMs,omitempty"`
	MotionStateAtMs      int64     `json:"motionStateAtMs,omitempty"`
	RGBStateAtMs         int64     `json:"rgbStateAtMs,omitempty"`
	BatteryAtMs          int64     `json:"batteryAtMs,omitempty"`
	LightAtMs            int64     `json:"lightAtMs,omitempty"`
	LinkAtMs             int64     `json:"linkAtMs,omitempty"`
	IdentityAtMs         int64     `json:"identityAtMs,omitempty"`
	OTAAtMs              int64     `json:"otaAtMs,omitempty"`
}

// UpdateHeartbeatRTT stores a lightly smoothed WebSocket ping/pong round-trip
// measurement. This is actual transport RTT, unlike LastSeen which only says
// how old the latest status report is.
func (h *Hub) UpdateHeartbeatRTT(id string, rtt time.Duration) {
	if rtt < 0 {
		return
	}
	value := float64(rtt.Microseconds()) / 1000
	if value < 0.1 {
		value = 0.1
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.entries[id]
	if e == nil {
		return
	}
	if e.device.HeartbeatRTTMs > 0 {
		value = e.device.HeartbeatRTTMs*0.7 + value*0.3
	}
	e.device.HeartbeatRTTMs = math.Round(value*10) / 10
}

// TouchHeartbeat records transport-level liveness without treating a pong as
// a device state update. Application heartbeat messages remain useful for
// telemetry, while WebSocket pong frames prevent a busy command queue from
// making a healthy connection look inactive.
func (h *Hub) TouchHeartbeat(id string, rtt time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.entries[id]
	if e == nil {
		return
	}
	now := time.Now()
	e.device.LastSeen = now
	e.device.HeartbeatAtMs = now.UnixMilli()
	if rtt >= 0 {
		value := float64(rtt.Microseconds()) / 1000
		if value < 0.1 {
			value = 0.1
		}
		if e.device.HeartbeatRTTMs > 0 {
			value = e.device.HeartbeatRTTMs*0.7 + value*0.3
		}
		e.device.HeartbeatRTTMs = math.Round(value*10) / 10
	}
}

// HeartbeatRTT returns the latest smoothed device WebSocket round-trip time.
// HTTP command handlers use it to avoid treating public-network delay as a
// device failure.
func (h *Hub) HeartbeatRTT(id string) (time.Duration, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	e := h.entries[id]
	if e == nil || e.device.HeartbeatRTTMs <= 0 {
		return 0, false
	}
	return time.Duration(e.device.HeartbeatRTTMs * float64(time.Millisecond)), true
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
	if d.ProtocolVersion >= 2 {
		d.IdentityAtMs = d.LastSeen.UnixMilli()
	}
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
	now := time.Now()
	nowMs := now.UnixMilli()
	e.device.LastSeen = now
	if _, ok := values["uptimeMs"]; ok {
		e.device.HeartbeatAtMs = nowMs
	}
	if _, ok := values["mode"]; ok {
		e.device.MotionStateAtMs = nowMs
	}
	if _, ok := values["rgbMode"]; ok {
		e.device.RGBStateAtMs = nowMs
	}
	if _, ok := values["batteryVoltage"]; ok {
		e.device.BatteryAtMs = nowMs
	}
	if _, ok := values["lightSensorOnline"]; ok {
		e.device.LightAtMs = nowMs
	}
	if _, ok := values["rssi"]; ok {
		e.device.LinkAtMs = nowMs
	}
	if _, ok := values["servoCenter"]; ok {
		e.device.IdentityAtMs = nowMs
	}
	if _, ok := values["otaState"]; ok {
		e.device.OTAAtMs = nowMs
	}
	if requestID, ok := values["requestId"].(string); ok && requestID != "" {
		e.device.LastCommandRequestID = requestID
		e.device.LastCommandAcked = true
		e.device.CommandAckAtMs = nowMs
		if success, ok := values["success"].(bool); ok {
			e.device.LastCommandSuccess = success
		}
		if code, ok := values["code"].(string); ok {
			e.device.LastCommandCode = code
		}
		if message, ok := values["message"].(string); ok {
			e.device.LastCommandMessage = message
		}
	}
	if v, ok := values["mode"].(float64); ok {
		e.device.Mode = int(v)
	} else if v, ok := values["mode"].(string); ok {
		if mode, valid := motionModeFromString(v); valid {
			e.device.Mode = mode
		}
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
	if v, ok := values["otaProgress"].(float64); ok && v >= 0 && v <= 100 {
		e.device.OTAProgress = int(v)
	}
	if v, ok := values["lightSensorOnline"].(bool); ok {
		e.device.LightSensorOnline = v
		if !v {
			e.device.IlluminanceLux = 0
		}
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
	if v, ok := values["servoCenter"].(float64); ok && v >= 0 && v <= 180 {
		e.device.ServoCenter = v
	}
	if v, ok := values["bootId"].(string); ok {
		e.device.BootID = v
	}
	if v, ok := values["protocolVersion"].(float64); ok && v == 2 {
		e.device.ProtocolVersion = int(v)
	}
	if values, ok := values["sensors"].([]any); ok {
		e.device.Sensors = e.device.Sensors[:0]
		for _, value := range values {
			if sensor, ok := value.(string); ok && sensor != "" {
				e.device.Sensors = append(e.device.Sensors, sensor)
			}
		}
	}
	if v, ok := values["servoPin"].(float64); ok && v >= 0 && v <= 48 {
		e.device.ServoPin = int(v)
	}
	if v, ok := values["statusLedPin"].(float64); ok && v >= 0 && v <= 48 {
		e.device.StatusLedPin = int(v)
	}
	if v, ok := values["batterySensePin"].(float64); ok && v >= 0 && v <= 48 {
		e.device.BatterySensePin = int(v)
	}
	if v, ok := values["batteryDividerRatio"].(float64); ok && v > 0 && v < 100 {
		e.device.BatteryDividerRatio = v
	}
	if v, ok := values["batteryEmptyVoltage"].(float64); ok && v >= 0 && v < 100 {
		e.device.BatteryEmptyVoltage = v
	}
	if v, ok := values["batteryFullVoltage"].(float64); ok && v >= 0 && v < 100 {
		e.device.BatteryFullVoltage = v
	}
	if !reflect.DeepEqual(before, deviceDisplaySignature(e.device)) {
		h.notifyLocked()
	}
}

func motionModeFromString(value string) (int, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "stopped", "stop":
		return 0, true
	case "idle":
		return 1, true
	case "forward":
		return 2, true
	case "left":
		return 3, true
	case "right":
		return 4, true
	default:
		return 0, false
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

// ResetLatestSequence starts a fresh browser control session at sequence 1.
// The sequence is transport-local state, so it must not survive a new lease
// owner or a page reload.
func (h *Hub) ResetLatestSequence(id string) bool {
	e := h.entry(id)
	if e == nil {
		return false
	}
	e.outboundMu.Lock()
	e.latestSequence = 0
	e.outboundMu.Unlock()
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
	if !r.queued {
		h.mu.Lock()
		delete(h.pending, requestID)
		h.mu.Unlock()
	}
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
	device.Sensors = append([]string(nil), device.Sensors...)
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
	ID                   string
	Name                 string
	IP                   string
	FirmwareVersion      string
	Online               bool
	Mode                 int
	Frequency            float64
	Amplitude            float64
	Bias                 float64
	StopReason           string
	BatteryVoltage       float64
	BatteryPercent       int
	Capabilities         []string
	Sensors              []string
	ServoPin             int
	StatusLedPin         int
	BatterySensePin      int
	BatteryDividerRatio  float64
	BatteryEmptyVoltage  float64
	BatteryFullVoltage   float64
	ControlSource        string
	VisionActive         bool
	VisionSessionID      string
	OTAState             string
	OTAProgress          int
	LightSensorOnline    bool
	IlluminanceLux       float64
	I2CAddresses         []int
	RGBMode              string
	RGBOrder             string
	RGBRed               int
	RGBGreen             int
	RGBBlue              int
	RGBBrightness        int
	ServoCenter          float64
	LastCommandRequestID string
	LastCommandAcked     bool
	LastCommandSuccess   bool
	LastCommandCode      string
	LastCommandMessage   string
	CommandAckAtMs       int64
}

func deviceDisplaySignature(device Device) deviceDisplayState {
	return deviceDisplayState{
		ID:                   device.ID,
		Name:                 device.Name,
		IP:                   device.IP,
		FirmwareVersion:      device.FirmwareVersion,
		Online:               device.Online,
		Mode:                 device.Mode,
		Frequency:            device.Frequency,
		Amplitude:            device.Amplitude,
		Bias:                 device.Bias,
		StopReason:           device.StopReason,
		BatteryVoltage:       device.BatteryVoltage,
		BatteryPercent:       device.BatteryPercent,
		Capabilities:         append([]string(nil), device.Capabilities...),
		Sensors:              append([]string(nil), device.Sensors...),
		ServoPin:             device.ServoPin,
		StatusLedPin:         device.StatusLedPin,
		BatterySensePin:      device.BatterySensePin,
		BatteryDividerRatio:  device.BatteryDividerRatio,
		BatteryEmptyVoltage:  device.BatteryEmptyVoltage,
		BatteryFullVoltage:   device.BatteryFullVoltage,
		ControlSource:        device.ControlSource,
		VisionActive:         device.VisionActive,
		VisionSessionID:      device.VisionSessionID,
		OTAState:             device.OTAState,
		OTAProgress:          device.OTAProgress,
		LightSensorOnline:    device.LightSensorOnline,
		IlluminanceLux:       device.IlluminanceLux,
		I2CAddresses:         append([]int(nil), device.I2CAddresses...),
		RGBMode:              device.RGBMode,
		RGBOrder:             device.RGBOrder,
		RGBRed:               device.RGBRed,
		RGBGreen:             device.RGBGreen,
		RGBBlue:              device.RGBBlue,
		RGBBrightness:        device.RGBBrightness,
		ServoCenter:          device.ServoCenter,
		LastCommandRequestID: device.LastCommandRequestID,
		LastCommandAcked:     device.LastCommandAcked,
		LastCommandSuccess:   device.LastCommandSuccess,
		LastCommandCode:      device.LastCommandCode,
		LastCommandMessage:   device.LastCommandMessage,
		CommandAckAtMs:       device.CommandAckAtMs,
	}
}
