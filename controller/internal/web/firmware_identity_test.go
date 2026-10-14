package web

import "testing"

func TestFirmwareIdentity(t *testing.T) {
	data := make([]byte, 400)
	data[0] = 0xe9
	copy(data[32:], []byte{0x32, 0x54, 0xcd, 0xab})
	data[176] = 1
	copy(data[300:], []byte("FISH_FW_VERSION=2.0.3-test\x00"))
	version, buildID := firmwareIdentity(data)
	if version != "2.0.3-test" || len(buildID) != 64 || buildID[:2] != "01" {
		t.Fatalf("unexpected identity %s %s", version, buildID)
	}
	version, buildID = firmwareIdentity([]byte{0xe9})
	if version != "" || buildID != "" {
		t.Fatal("legacy image must not invent identity")
	}
}
