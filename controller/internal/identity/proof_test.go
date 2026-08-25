package identity

import (
	"encoding/hex"
	"testing"
)

func TestProofMatchesCrossPlatformVector(t *testing.T) {
	key, _ := hex.DecodeString("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	proof, err := Proof(key, "fish-discovery-v1", "00112233445566778899aabbccddeeff", "AC:27:6E:7C:37:18")
	const expected = "7a230c9e3d58592fccba3c17d292d01d5c68840754e4c508d748d60abebe22ab"
	if err != nil || proof != expected {
		t.Fatalf("proof=%s err=%v", proof, err)
	}
	if !Verify(key, "fish-discovery-v1", "00112233445566778899aabbccddeeff", "AC:27:6E:7C:37:18", expected) {
		t.Fatal("合法证明应通过验证")
	}
	if Verify(key, "fish-discovery-v1", "wrong", "AC:27:6E:7C:37:18", expected) {
		t.Fatal("错误 nonce 不应通过验证")
	}
}

func TestNormalizeMACRejectsMalformedInput(t *testing.T) {
	if normalized, err := NormalizeMAC("AC:27:6E:7C:37:18"); err != nil || normalized != "ac276e7c3718" {
		t.Fatalf("MAC 标准化失败: %s %v", normalized, err)
	}
	if _, err := NormalizeMAC("not-a-mac"); err == nil {
		t.Fatal("错误 MAC 必须被拒绝")
	}
}
