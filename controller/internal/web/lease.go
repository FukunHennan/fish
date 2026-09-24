package web

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type controlLease struct {
	MotionExpired    bool      `json:"motionExpired"`
	DeadmanProtected bool      `json:"deadmanProtected,omitempty"`
	DeviceID         string    `json:"deviceId"`
	ClientID         string    `json:"clientId,omitempty"`
	OwnerID          string    `json:"ownerId"`
	OwnerName        string    `json:"ownerName"`
	OwnerEmail       string    `json:"ownerEmail"`
	Mode             string    `json:"mode"`
	AcquiredAt       time.Time `json:"acquiredAt"`
	ExpiresAt        time.Time `json:"expiresAt"`
	LastCommandAt    time.Time `json:"lastCommandAt"`
}

type leaseStore struct {
	mu        sync.Mutex
	path      string
	ttl       time.Duration
	leases    map[string]controlLease
	onRelease func(string)
}

func newLeaseStore(ttl time.Duration) *leaseStore {
	return &leaseStore{ttl: ttl, leases: map[string]controlLease{}}
}

func (l *leaseStore) cleanupLocked(now time.Time) []string {
	var expired []string
	for id, lease := range l.leases {
		if now.After(lease.ExpiresAt) && !lease.MotionExpired {
			l.stopLocked(id)
			if lease.OwnerID == "vision-bot" {
				delete(l.leases, id)
			} else {
				lease.MotionExpired = true
				l.leases[id] = lease
			}
			expired = append(expired, id)
		}
	}
	return expired
}

// Called while admission is locked: STOP must enter the device queue before a
// new owner can submit motion. The callback must never wait for device I/O.
func (l *leaseStore) stopLocked(id string) {
	l.stopLockedWithPolicy(id, false)
}

// High-priority takeover must clear a deadman-protected browser lease too.
func (l *leaseStore) forceStopLocked(id string) {
	l.stopLockedWithPolicy(id, true)
}

func (l *leaseStore) stopLockedWithPolicy(id string, force bool) {
	if !force {
		if lease, exists := l.leases[id]; exists && lease.DeadmanProtected {
			return
		}
	}
	if l.onRelease != nil {
		l.onRelease(id)
	}
}

func (l *leaseStore) setDeadmanProtected(deviceID string, user authUser, clientID string, enabled bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	lease, exists := l.leases[deviceID]
	if !exists || lease.OwnerID != user.ID || lease.ClientID != clientID {
		return false
	}
	lease.DeadmanProtected = enabled
	l.leases[deviceID] = lease
	return true
}

func (l *leaseStore) admit(deviceID string, user authUser, clientID string, required bool, queue func() bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.cleanupLocked(now)
	lease, exists := l.leases[deviceID]
	// Even STOP must not interfere with another browser's active lease.
	if exists && (lease.OwnerID != user.ID || lease.ClientID != clientID) {
		return false
	}
	if required && (!exists || lease.OwnerID != user.ID || lease.ClientID != clientID) {
		return false
	}
	// Expiry is a hard motion boundary. The old browser may still send a
	// queued frame after the watchdog has stopped the fish, but it must first
	// acquire a new lease explicitly before motion can resume.
	if required && (lease.MotionExpired || !now.Before(lease.ExpiresAt)) {
		return false
	}
	if !queue() {
		return false
	}
	if exists && lease.OwnerID == user.ID && lease.ClientID == clientID {
		if !lease.MotionExpired {
			lease.ExpiresAt, lease.LastCommandAt = now.Add(l.ttl), now
		}
		l.leases[deviceID] = lease
	}
	return true
}

func (l *leaseStore) admitVision(deviceID, operation string, queue func() bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.cleanupLocked(now)
	current, exists := l.leases[deviceID]
	if exists && current.OwnerID != "vision-bot" {
		// Vision is an operator-approved high-priority control path. Queue a
		// neutral command before replacing any browser lease, including one
		// protected by a deadman timeout.
		l.forceStopLocked(deviceID)
		delete(l.leases, deviceID)
	}
	if !queue() {
		return false
	}
	if operation == "stop" {
		delete(l.leases, deviceID)
	} else {
		l.leases[deviceID] = controlLease{DeviceID: deviceID, OwnerID: "vision-bot", OwnerName: "vision-bot", OwnerEmail: "vision-bot", Mode: "vision", AcquiredAt: now, LastCommandAt: now, ExpiresAt: now.Add(l.ttl)}
	}
	return true
}

func (l *leaseStore) releaseIdleVision(active func(string) bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	changed := false
	for id, lease := range l.leases {
		if lease.OwnerID == "vision-bot" && !active(id) {
			delete(l.leases, id)
			changed = true
		}
	}
	return changed
}

func (l *leaseStore) releaseBrowserLeases() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, lease := range l.leases {
		if lease.OwnerID == "vision-bot" {
			continue
		}
		l.forceStopLocked(id)
		delete(l.leases, id)
	}
	_ = l.saveLocked()
}

func (l *leaseStore) snapshot() map[string]controlLease {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[string]controlLease, len(l.leases))
	for id, lease := range l.leases {
		out[id] = lease
	}
	return out
}

func (l *leaseStore) acquire(deviceID string, user authUser, mode string, force bool) (controlLease, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.cleanupLocked(now)
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "manual"
	}
	if current, ok := l.leases[deviceID]; ok && current.OwnerID != user.ID && !force {
		return current, false
	}
	lease := controlLease{
		DeviceID: deviceID, OwnerID: user.ID, OwnerName: user.Name, OwnerEmail: user.Email,
		Mode: mode, AcquiredAt: now, ExpiresAt: now.Add(l.ttl), LastCommandAt: now,
	}
	l.leases[deviceID] = lease
	return lease, true
}

func (l *leaseStore) acquireExclusive(deviceID string, user authUser, mode string, force bool, clients ...string) (controlLease, []string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.cleanupLocked(now)
	clientID := ""
	if len(clients) > 0 {
		clientID = clients[0]
	}
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "manual"
	}
	// A login may have several tabs, but only one live browser client may
	// control that account at a time. Keep administrator takeover for other
	// accounts, while preventing an admin's own stale/duplicate tab from
	// repeatedly replacing the active lease and injecting STOP frames.
	if clientID != "" {
		for _, active := range l.leases {
			if active.OwnerID != user.ID || active.ClientID == "" || active.ClientID == clientID ||
				active.MotionExpired || !now.Before(active.ExpiresAt) {
				continue
			}
			return active, nil, false
		}
	}
	if current, ok := l.leases[deviceID]; ok && !force {
		// A stopped/expired lease is only a reservation. Let the same account
		// recover it from a new browser session, but keep active leases exclusive.
		staleSameOwner := current.OwnerID == user.ID &&
			(current.MotionExpired || !now.Before(current.ExpiresAt))
		if !staleSameOwner && (current.OwnerID != user.ID || (current.ClientID != "" && current.ClientID != clientID)) {
			return current, nil, false
		}
	}
	if current, ok := l.leases[deviceID]; ok && (current.OwnerID != user.ID || current.ClientID != clientID) {
		// cleanupLocked already queued the normal stop for an expired lease.
		// Force a second stop only when the old browser had a protected deadman
		// connection, because normal cleanup deliberately skips that redundant
		// frame.
		if force || (ok && current.OwnerID == user.ID && current.DeadmanProtected && (current.MotionExpired || !now.Before(current.ExpiresAt))) {
			l.forceStopLocked(deviceID)
		} else {
			l.stopLocked(deviceID)
		}
	}
	// Exclusivity is per device; a user may hold several devices.
	lease := controlLease{
		ClientID: clientID,
		DeviceID: deviceID, OwnerID: user.ID, OwnerName: user.Name, OwnerEmail: user.Email,
		Mode: mode, AcquiredAt: now, ExpiresAt: now.Add(l.ttl), LastCommandAt: now,
	}
	previous, existed := l.leases[deviceID]
	l.leases[deviceID] = lease
	if err := l.saveLocked(); err != nil {
		if existed {
			l.leases[deviceID] = previous
		} else {
			delete(l.leases, deviceID)
		}
		return previous, nil, false
	}
	return lease, nil, true
}

func (l *leaseStore) acquireBot(deviceID, botName, mode string) (controlLease, bool) {
	return l.acquire(deviceID, authUser{ID: botName, Name: botName, Email: botName, Role: "User", Status: "active"}, mode, false)
}

func (l *leaseStore) release(deviceID string, user authUser, force bool, clients ...string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cleanupLocked(time.Now())
	current, ok := l.leases[deviceID]
	if !ok {
		return true
	}
	if current.OwnerID != user.ID && !force {
		return false
	}
	if len(clients) > 0 && current.ClientID != clients[0] && !force {
		return false
	}
	if force {
		l.forceStopLocked(deviceID)
	} else {
		l.stopLocked(deviceID)
	}
	delete(l.leases, deviceID)
	if err := l.saveLocked(); err != nil {
		l.leases[deviceID] = current
		return false
	}
	return true
}

func (l *leaseStore) releaseBot(deviceID, botName string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if current, ok := l.leases[deviceID]; ok && current.OwnerID == botName {
		delete(l.leases, deviceID)
	}
}

func (l *leaseStore) touch(deviceID string, user authUser) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.cleanupLocked(now)
	current, ok := l.leases[deviceID]
	if !ok || current.OwnerID != user.ID || current.MotionExpired || !now.Before(current.ExpiresAt) {
		return false
	}
	current.MotionExpired = false
	current.LastCommandAt = now
	current.ExpiresAt = now.Add(l.ttl)
	l.leases[deviceID] = current
	return true
}

func (l *leaseStore) expire() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cleanupLocked(time.Now())
}

func (l *leaseStore) touchBot(deviceID, botName string) bool {
	return l.touch(deviceID, authUser{ID: botName})
}

func canControl(user authUser) bool {
	return user.Status == "active" && (user.Role == "User" || user.Role == "Admin")
}

func canAdmin(user authUser) bool {
	return user.Status == "active" && user.Role == "Admin"
}

// Reservations survive service restarts; transport sessions never resume motion.
func (l *leaseStore) loadReservations(path string) error {
	l.path = path
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &l.leases); err != nil {
		return err
	}
	if l.leases == nil {
		l.leases = map[string]controlLease{}
	}
	for id, lease := range l.leases {
		lease.MotionExpired = true
		lease.ClientID = ""
		l.leases[id] = lease
	}
	return nil
}
func (l *leaseStore) saveLocked() error {
	if l.path == "" {
		return nil
	}
	reservations := map[string]controlLease{}
	for id, lease := range l.leases {
		if lease.OwnerID != "vision-bot" {
			reservations[id] = lease
		}
	}
	data, err := json.Marshal(reservations)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(l.path), 0700); err != nil {
		return err
	}
	if err = os.WriteFile(l.path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(l.path+".tmp", l.path)
}
