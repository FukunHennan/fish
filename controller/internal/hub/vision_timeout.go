package hub

import (
	"errors"
	"fmt"
	"time"
)

var errMotionExpired = errors.New("motion command expired before delivery")

func (h *Hub) VisionSessionActive(id string) bool {
	e := h.entry(id)
	if e == nil {
		return false
	}
	e.outboundMu.Lock()
	defer e.outboundMu.Unlock()
	return !e.outboundStopped && e.visionSession != ""
}

func (e *entry) invalidateVisionLocked() {
	e.visionSession = ""
	e.visionDeadline = time.Time{}
	for _, message := range e.outbound {
		if !message.motionExpires.IsZero() {
			message.motionExpires = time.Unix(0, 1)
		}
	}
	e.dropExpiredMotionLocked(time.Now())
}

// StopAndReset is nonblocking and is safe to call while a lease is locked.
func (h *Hub) StopAndReset(id string) bool {
	e := h.entry(id)
	if e == nil {
		return false
	}
	e.outboundMu.Lock()
	defer e.outboundMu.Unlock()
	if e.outboundStopped {
		return false
	}
	e.invalidateVisionLocked()
	e.latestSequence = 0
	kept := e.outbound[:0]
	for _, message := range e.outbound {
		value, _ := message.value.(map[string]any)
		if value["command"] == "motion.set" {
			completeOutbound(message, errMotionExpired)
			if message == e.latestPending {
				e.latestPending = nil
			}
			continue
		}
		kept = append(kept, message)
	}
	e.outbound = kept
	e.nextOrder++
	e.outbound = append(e.outbound, &outboundMessage{order: e.nextOrder, value: map[string]any{
		"type": "command", "requestId": fmt.Sprintf("lease-stop-%d", time.Now().UnixNano()), "command": "motion.set",
		"payload": map[string]any{"deviceId": id, "controlSource": "lease", "mode": "stop", "frequency": 0.3, "amplitude": 0.0, "bias": 0.0},
	}})
	select {
	case e.outboundWake <- struct{}{}:
	default:
	}
	return true
}

// Heartbeats, RGB updates and telemetry must not extend or cancel motion expiry.
func replacesMotion(value any) bool {
	message, ok := value.(map[string]any)
	if !ok {
		return false
	}
	switch message["command"] {
	case "motion.set", "emergency.stop", "ota.start":
		return true
	}
	return false
}

func (e *entry) dropExpiredMotionLocked(now time.Time) {
	kept := e.outbound[:0]
	for _, message := range e.outbound {
		if !message.motionExpires.IsZero() && !now.Before(message.motionExpires) {
			completeOutbound(message, errMotionExpired)
			continue
		}
		kept = append(kept, message)
	}
	for i := len(kept); i < len(e.outbound); i++ {
		e.outbound[i] = nil
	}
	e.outbound = kept
}

// StopExpiredVisionMotion checks and queues STOP under the same lock used for
// motion acceptance, so a timeout cannot overtake a concurrent manual takeover.
// It never waits for network I/O or an ACK, allowing all devices to be checked.
func (h *Hub) StopExpiredVisionMotion(now time.Time) []string {
	h.mu.RLock()
	entries := make(map[string]*entry, len(h.entries))
	for id, e := range h.entries {
		entries[id] = e
	}
	h.mu.RUnlock()
	var stopped []string
	for id, e := range entries {
		e.outboundMu.Lock()
		if e.outboundStopped || e.visionDeadline.IsZero() || now.Before(e.visionDeadline) {
			e.outboundMu.Unlock()
			continue
		}
		e.visionDeadline = time.Time{}
		e.visionSession = ""
		e.dropExpiredMotionLocked(now)
		e.nextOrder++
		e.outbound = append(e.outbound, &outboundMessage{
			order: e.nextOrder,
			value: map[string]any{
				"type": "command", "requestId": fmt.Sprintf("vision-timeout-%d-%s", now.UnixNano(), id),
				"deviceId": id, "command": "motion.set",
				"payload": map[string]any{"deviceId": id, "mode": "stop", "frequency": 0.3, "amplitude": 0.0, "bias": 0.0, "controlSource": "vision-timeout"},
			},
		})
		select {
		case e.outboundWake <- struct{}{}:
		default:
		}
		e.outboundMu.Unlock()
		stopped = append(stopped, id)
	}
	return stopped
}
