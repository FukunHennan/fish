package discovery

import (
	"fish-controller/internal/identity"
	"testing"
	"time"
)

func TestVerifierAcceptsOnceAndRejectsReplay(t *testing.T) {
	key := make([]byte, 32)
	now := time.Unix(100, 0)
	verifier := NewVerifier(key, 10*time.Second)
	request := verifier.NewRequest(now)
	proof, _ := identity.Proof(key, discoveryDomain, request.Nonce, "AC:27:6E:7C:37:18")
	response := Response{Type: "discovery.response", ProtocolVersion: 1, RequestID: request.RequestID, Nonce: request.Nonce, DeviceID: "AC:27:6E:7C:37:18", Proof: proof}
	if !verifier.Accept(response, now.Add(time.Second)) {
		t.Fatal("合法回复应被接受")
	}
	if verifier.Accept(response, now.Add(2*time.Second)) {
		t.Fatal("重复回复必须被拒绝")
	}
}

func TestVerifierRejectsExpiredAndInvalidProof(t *testing.T) {
	key := make([]byte, 32)
	now := time.Unix(100, 0)
	verifier := NewVerifier(key, 10*time.Second)
	request := verifier.NewRequest(now)
	bad := Response{Type: "discovery.response", ProtocolVersion: 1, RequestID: request.RequestID, Nonce: request.Nonce, DeviceID: "AC:27:6E:7C:37:18", Proof: "00"}
	if verifier.Accept(bad, now.Add(time.Second)) {
		t.Fatal("错误 proof 必须被拒绝")
	}
	proof, _ := identity.Proof(key, discoveryDomain, request.Nonce, bad.DeviceID)
	bad.Proof = proof
	if verifier.Accept(bad, now.Add(11*time.Second)) {
		t.Fatal("过期回复必须被拒绝")
	}
}

func TestVerifierAcceptsAuthenticatedDeviceAnnouncement(t *testing.T) {
	key := make([]byte, 32)
	now := time.Unix(100, 0)
	verifier := NewVerifier(key, 10*time.Second)
	proof, _ := identity.Proof(key, deviceAnnouncementDomain, "device-nonce-001", "AC:27:6E:7C:37:18")
	announcement := Announcement{Type: "device.announce", ProtocolVersion: 2, Nonce: "device-nonce-001", DeviceID: "AC:27:6E:7C:37:18", Proof: proof}
	if !verifier.AcceptAnnouncement(announcement, now) {
		t.Fatal("合法的设备主动广播应被接受")
	}
	if verifier.AcceptAnnouncement(announcement, now.Add(time.Second)) {
		t.Fatal("重复广播 nonce 必须被拒绝")
	}
}

func TestControllerOfferEchoesNonceAndUsesConfiguredWebSocketPort(t *testing.T) {
	key := make([]byte, 32)
	announcement := Announcement{Nonce: "device-nonce-001", DeviceID: "AC:27:6E:7C:37:18"}
	offer, err := NewOffer(key, announcement, 8081)
	if err != nil {
		t.Fatal(err)
	}
	if offer.Type != "controller.offer" || offer.ProtocolVersion != 2 {
		t.Fatalf("错误的回复类型: %#v", offer)
	}
	if offer.Nonce != announcement.Nonce || offer.DeviceID != announcement.DeviceID || offer.ControllerPort != 8081 {
		t.Fatalf("回复未绑定设备广播: %#v", offer)
	}
	if !identity.Verify(key, controllerOfferDomain, offer.Nonce, offer.DeviceID, offer.Proof) {
		t.Fatal("控制器回复签名无效")
	}
}
