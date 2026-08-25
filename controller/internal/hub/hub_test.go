package hub

import "testing"

type fakeConn struct{ sent []any }

func (f *fakeConn) WriteJSON(v any) error { f.sent = append(f.sent, v); return nil }
func (f *fakeConn) Close() error          { return nil }

func TestRegisterAndRouteCommand(t *testing.T) {
	h := New()
	c := &fakeConn{}
	h.Register(Device{ID: "AC:27:6E:7C:37:18", Name: "测试鱼"}, c)
	result := h.Send("AC:27:6E:7C:37:18", map[string]any{"type": "command"})
	if !result || len(c.sent) != 1 {
		t.Fatalf("命令没有发送到已注册设备")
	}
}

func TestOfflineDeviceCannotReceiveCommand(t *testing.T) {
	h := New()
	if h.Send("00:00:00:00:00:00", map[string]any{"type": "command"}) {
		t.Fatal("离线设备不应返回发送成功")
	}
}

func TestDeviceStateUpdateKeepsDashboardFields(t *testing.T) {
	h := New()
	c := &fakeConn{}
	h.Register(Device{ID: "AC:27:6E:7C:37:18", Name: "测试鱼"}, c)
	h.Update("AC:27:6E:7C:37:18", map[string]any{
		"mode": 1.0, "frequency": 2.8, "amplitude": 31.0, "bias": -6.0,
		"rssi": -48.0, "ip": "192.168.137.117", "firmwareVersion": "1.1.0",
		"uptimeMs": 12345.0, "lastControlMs": 12000.0, "stopReason": "",
	})
	d := h.List()[0]
	if d.Bias != -6 || d.IP != "192.168.137.117" || d.UptimeMs != 12345 || d.LastControlMs != 12000 {
		t.Fatalf("设备状态字段未完整保存: %+v", d)
	}
}

func TestDeviceCanRegisterAgainAfterDisconnect(t *testing.T) {
	h := New()
	first := &fakeConn{}
	second := &fakeConn{}
	h.Register(Device{ID: "fish-1"}, first)
	h.Remove("fish-1", first)
	h.Register(Device{ID: "fish-1"}, second)
	if devices := h.List(); len(devices) != 1 || !devices[0].Online {
		t.Fatalf("设备重连后应恢复在线: %+v", devices)
	}
}

func TestSendOnlyRequiresExactlyOneConnectedDevice(t *testing.T) {
	h := New()
	first := &fakeConn{}
	if h.SendOnly(map[string]any{"command": "vision.stop"}) {
		t.Fatal("没有设备时不应发送")
	}
	h.Register(Device{ID: "fish-1"}, first)
	if !h.SendOnly(map[string]any{"command": "vision.stop"}) || len(first.sent) != 1 {
		t.Fatal("唯一在线设备没有收到视觉命令")
	}
	h.Register(Device{ID: "fish-2"}, &fakeConn{})
	if h.SendOnly(map[string]any{"command": "vision.stop"}) {
		t.Fatal("多设备且未选择目标时不应发送")
	}
}
