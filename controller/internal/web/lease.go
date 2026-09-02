package web

import (
	"strings"
	"sync"
	"time"
)

type controlLease struct {
	DeviceID      string    `json:"deviceId"`
	OwnerID       string    `json:"ownerId"`
	OwnerName     string    `json:"ownerName"`
	OwnerEmail    string    `json:"ownerEmail"`
	Mode          string    `json:"mode"`
	AcquiredAt    time.Time `json:"acquiredAt"`
	ExpiresAt     time.Time `json:"expiresAt"`
	LastCommandAt time.Time `json:"lastCommandAt"`
}

type leaseStore struct {
	mu     sync.Mutex
	ttl    time.Duration
	leases map[string]controlLease
}

func newLeaseStore(ttl time.Duration) *leaseStore {
	return &leaseStore{ttl: ttl, leases: map[string]controlLease{}}
}

func (l *leaseStore) cleanupLocked(now time.Time) []string {
	var expired []string
	for id, lease := range l.leases {
		if now.After(lease.ExpiresAt) {
			delete(l.leases, id)
			expired = append(expired, id)
		}
	}
	return expired
}

func (l *leaseStore) snapshot() map[string]controlLease {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	out := make(map[string]controlLease, len(l.leases))
	for id, lease := range l.leases {
		if now.After(lease.ExpiresAt) {
			continue
		}
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

func (l *leaseStore) acquireExclusive(deviceID string, user authUser, mode string, force bool) (controlLease, []string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.cleanupLocked(now)
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "manual"
	}
	if current, ok := l.leases[deviceID]; ok && current.OwnerID != user.ID && !force {
		return current, nil, false
	}
	released := make([]string, 0, 1)
	for id, lease := range l.leases {
		if id == deviceID || lease.OwnerID != user.ID {
			continue
		}
		delete(l.leases, id)
		released = append(released, id)
	}
	lease := controlLease{
		DeviceID: deviceID, OwnerID: user.ID, OwnerName: user.Name, OwnerEmail: user.Email,
		Mode: mode, AcquiredAt: now, ExpiresAt: now.Add(l.ttl), LastCommandAt: now,
	}
	l.leases[deviceID] = lease
	return lease, released, true
}

func (l *leaseStore) acquireBot(deviceID, botName, mode string) (controlLease, bool) {
	return l.acquire(deviceID, authUser{ID: botName, Name: botName, Email: botName, Role: "Operator", Status: "active"}, mode, false)
}

func (l *leaseStore) release(deviceID string, user authUser, force bool) bool {
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
	delete(l.leases, deviceID)
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
	if !ok || current.OwnerID != user.ID {
		return false
	}
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
	return user.Status == "active" && (user.Role == "Operator" || user.Role == "Admin")
}

func canAdmin(user authUser) bool {
	return user.Status == "active" && user.Role == "Admin"
}
