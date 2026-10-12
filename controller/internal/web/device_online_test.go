package web

import (
	"testing"
	"time"

	"fish-controller/internal/hub"
)

func TestDeviceFreshlyOnlineUsesRecentTransportHeartbeat(t *testing.T) {
	if !deviceFreshlyOnline(hub.Device{Online: true, HeartbeatAtMs: time.Now().Add(-4 * time.Second).UnixMilli()}) {
		t.Fatal("recently seen device should be online")
	}
	if deviceFreshlyOnline(hub.Device{Online: true, HeartbeatAtMs: time.Now().Add(-6 * time.Second).UnixMilli()}) {
		t.Fatal("stale device should be offline")
	}
	if deviceFreshlyOnline(hub.Device{Online: false, HeartbeatAtMs: time.Now().UnixMilli()}) {
		t.Fatal("disconnected device should be offline")
	}
	if deviceFreshlyOnline(hub.Device{Online: true}) {
		t.Fatal("device without a heartbeat timestamp should be offline")
	}
}
