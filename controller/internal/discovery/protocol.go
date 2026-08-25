package discovery

import (
	"crypto/rand"
	"encoding/hex"
	"fish-controller/internal/identity"
	"sync"
	"time"
)

const discoveryDomain = "fish-discovery-v1"
const deviceAnnouncementDomain = "fish-device-announce-v2"
const controllerOfferDomain = "fish-controller-offer-v2"
const Port = 30303

type Announcement struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	Nonce           string `json:"nonce"`
	DeviceID        string `json:"deviceId"`
	Proof           string `json:"proof"`
	Name            string `json:"name"`
	FirmwareVersion string `json:"firmwareVersion"`
}

type Offer struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	Nonce           string `json:"nonce"`
	DeviceID        string `json:"deviceId"`
	ControllerPort  uint16 `json:"controllerPort"`
	Proof           string `json:"proof"`
}

type Request struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	RequestID       string `json:"requestId"`
	Nonce           string `json:"nonce"`
}

type Response struct {
	Type            string  `json:"type"`
	ProtocolVersion int     `json:"protocolVersion"`
	RequestID       string  `json:"requestId"`
	Nonce           string  `json:"nonce"`
	DeviceID        string  `json:"deviceId"`
	Proof           string  `json:"proof"`
	IP              string  `json:"ip"`
	Name            string  `json:"name"`
	FirmwareVersion string  `json:"firmwareVersion"`
	RSSI            int     `json:"rssi"`
	UptimeMs        uint64  `json:"uptimeMs"`
	Mode            int     `json:"mode"`
	Frequency       float64 `json:"frequency"`
	Amplitude       float64 `json:"amplitude"`
	Bias            float64 `json:"bias"`
	StopReason      string  `json:"stopReason"`
}

type challenge struct {
	nonce   string
	expires time.Time
	seen    map[string]bool
}

type Verifier struct {
	mu            sync.Mutex
	key           []byte
	ttl           time.Duration
	pending       map[string]*challenge
	announcements map[string]time.Time
}

func NewVerifier(key []byte, ttl time.Duration) *Verifier {
	return &Verifier{key: append([]byte(nil), key...), ttl: ttl, pending: make(map[string]*challenge), announcements: make(map[string]time.Time)}
}

func (v *Verifier) AcceptAnnouncement(a Announcement, now time.Time) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	for nonce, expires := range v.announcements {
		if now.After(expires) {
			delete(v.announcements, nonce)
		}
	}
	if a.Type != "device.announce" || a.ProtocolVersion != 2 || len(a.Nonce) < 8 || a.DeviceID == "" || v.announcements[a.Nonce].After(now) {
		return false
	}
	if !identity.Verify(v.key, deviceAnnouncementDomain, a.Nonce, a.DeviceID, a.Proof) {
		return false
	}
	v.announcements[a.Nonce] = now.Add(v.ttl)
	return true
}

func NewOffer(key []byte, a Announcement, port uint16) (Offer, error) {
	proof, err := identity.Proof(key, controllerOfferDomain, a.Nonce, a.DeviceID)
	if err != nil {
		return Offer{}, err
	}
	return Offer{Type: "controller.offer", ProtocolVersion: 2, Nonce: a.Nonce, DeviceID: a.DeviceID, ControllerPort: port, Proof: proof}, nil
}

func randomHex(size int) string {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return hex.EncodeToString(data)
}

func (v *Verifier) NewRequest(now time.Time) Request {
	v.mu.Lock()
	defer v.mu.Unlock()
	for id, item := range v.pending {
		if now.After(item.expires) {
			delete(v.pending, id)
		}
	}
	request := Request{Type: "discovery.request", ProtocolVersion: 1, RequestID: randomHex(8), Nonce: randomHex(16)}
	v.pending[request.RequestID] = &challenge{nonce: request.Nonce, expires: now.Add(v.ttl), seen: make(map[string]bool)}
	return request
}

func (v *Verifier) Accept(response Response, now time.Time) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	item := v.pending[response.RequestID]
	if item == nil || now.After(item.expires) || response.Type != "discovery.response" || response.ProtocolVersion != 1 || response.Nonce != item.nonce || item.seen[response.DeviceID] {
		return false
	}
	if !identity.Verify(v.key, discoveryDomain, item.nonce, response.DeviceID, response.Proof) {
		return false
	}
	item.seen[response.DeviceID] = true
	return true
}
