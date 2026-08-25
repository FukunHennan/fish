package identity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"strings"
)

func NormalizeMAC(value string) (string, error) {
	mac, err := net.ParseMAC(value)
	if err != nil || len(mac) != 6 {
		return "", errors.New("MAC 地址格式无效")
	}
	return strings.ToLower(hex.EncodeToString(mac)), nil
}

func Proof(key []byte, domain, nonce, mac string) (string, error) {
	if len(key) != 32 || domain == "" || nonce == "" {
		return "", errors.New("HMAC 参数无效")
	}
	normalized, err := NormalizeMAC(mac)
	if err != nil {
		return "", err
	}
	digest := hmac.New(sha256.New, key)
	_, _ = digest.Write([]byte(domain + "\n" + nonce + "\n" + normalized))
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func Verify(key []byte, domain, nonce, mac, proof string) bool {
	expected, err := Proof(key, domain, nonce, mac)
	if err != nil {
		return false
	}
	expectedBytes, errExpected := hex.DecodeString(expected)
	proofBytes, errProof := hex.DecodeString(proof)
	return errExpected == nil && errProof == nil && hmac.Equal(expectedBytes, proofBytes)
}
