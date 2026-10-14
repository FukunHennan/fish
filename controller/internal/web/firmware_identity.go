package web

import (
	"bytes"
	"encoding/hex"
)

func firmwareIdentity(data []byte) (string, string) {
	if len(data) < 288 || data[0] != 0xe9 || !bytes.Equal(data[32:36], []byte{0x32, 0x54, 0xcd, 0xab}) {
		return "", ""
	}
	description := data[32:288]
	version := ""
	marker := []byte("FISH_FW_VERSION=")
	if offset := bytes.Index(data, marker); offset >= 0 {
		remaining := data[offset+len(marker):]
		if end := bytes.IndexByte(remaining, 0); end > 0 && end < 32 {
			version = string(remaining[:end])
		}
	}
	buildID := description[144:176]
	if bytes.Equal(buildID, make([]byte, 32)) {
		return version, ""
	}
	return version, hex.EncodeToString(buildID)
}
