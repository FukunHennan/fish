package hub

import (
	"sync"
	"testing"
	"time"
)

type fakeConn struct {
	mu   sync.Mutex
	sent []any
}

func (f *fakeConn) WriteJSON(v any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, v)
	return nil
}
func (f *fakeConn) Close() error { return nil }
func (f *fakeConn) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

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
		"batteryVoltage": 7.82, "batteryPercent": 76.0, "batterySampleAgeMs": 321.0,
	})
	d := h.List()[0]
	if d.Bias != -6 || d.IP != "192.168.137.117" || d.UptimeMs != 12345 || d.LastControlMs != 12000 || d.BatteryVoltage != 7.82 || d.BatteryPercent != 76 || d.BatterySampleAgeMs != 321 {
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

func TestHubKeepsRegistrationOrderAcrossStateUpdatesAndReconnect(t *testing.T) {
	h := New()
	first := &fakeConn{}
	second := &fakeConn{}
	h.Register(Device{ID: "fish-b"}, first)
	h.Register(Device{ID: "fish-a"}, second)
	h.Update("fish-b", map[string]any{
		"uptimeMs": 100.0, "lastControlMs": 80.0, "batterySampleAgeMs": 10.0, "rssi": -45.0,
	})
	if devices := h.List(); len(devices) != 2 || devices[0].ID != "fish-b" || devices[1].ID != "fish-a" {
		t.Fatalf("设备状态更新不应改变列表顺序: %+v", devices)
	}
	h.Remove("fish-b", first)
	h.Register(Device{ID: "fish-b"}, &fakeConn{})
	if devices := h.List(); len(devices) != 2 || devices[0].ID != "fish-b" || devices[1].ID != "fish-a" {
		t.Fatalf("设备重新上线后的顺序异常: %+v", devices)
	}
}

func TestHeartbeatOnlyUpdateDoesNotNotifyDashboard(t *testing.T) {
	h := New()
	h.Register(Device{ID: "fish-1"}, &fakeConn{})
	updates, unsubscribe := h.Subscribe()
	defer unsubscribe()
	h.Update("fish-1", map[string]any{
		"uptimeMs": 100.0, "lastControlMs": 80.0, "batterySampleAgeMs": 10.0, "rssi": -45.0,
	})
	select {
	case <-updates:
		t.Fatal("只有心跳字段变化时不应推送设备事件")
	default:
	}
	h.Update("fish-1", map[string]any{"mode": 2.0})
	select {
	case <-updates:
	case <-time.After(time.Second):
		t.Fatal("可见设备状态变化没有推送设备事件")
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

func TestSendAndWaitClosesCommandLoop(t *testing.T) {
	h := New()
	c := &fakeConn{}
	h.Register(Device{ID: "fish-1"}, c)
	go func() {
		for c.count() == 0 {
			time.Sleep(time.Millisecond)
		}
		h.ResolveCommandResult(map[string]any{"type": "command.result", "requestId": "req-1", "success": true})
	}()
	ack, sent, acknowledged := h.SendAndWait("fish-1", "req-1", map[string]any{"type": "command"}, time.Second)
	if !sent || !acknowledged || ack["success"] != true {
		t.Fatalf("command loop did not close: sent=%v acknowledged=%v ack=%#v", sent, acknowledged, ack)
	}
}

type blockingConn struct {
	mu      sync.Mutex
	sent    []any
	started chan struct{}
	release chan struct{}
	first   bool
}

func (c *blockingConn) WriteJSON(v any) error {
	c.mu.Lock()
	first := c.first
	if first {
		c.first = false
		close(c.started)
	}
	c.mu.Unlock()
	if first {
		<-c.release
	}
	c.mu.Lock()
	c.sent = append(c.sent, v)
	c.mu.Unlock()
	return nil
}
func (c *blockingConn) Close() error { return nil }

func TestSendLatestKeepsOnlyNewestPendingCommand(t *testing.T) {
	h := New()
	c := &blockingConn{
		started: make(chan struct{}),
		release: make(chan struct{}),
		first:   true,
	}
	h.Register(Device{ID: "fish-1"}, c)

	if !h.SendLatest("fish-1", map[string]any{"sequence": 1}) {
		t.Fatal("首个实时命令没有进入队列")
	}
	select {
	case <-c.started:
	case <-time.After(time.Second):
		t.Fatal("实时写入循环没有启动")
	}
	if !h.SendLatest("fish-1", map[string]any{"sequence": 2}) ||
		!h.SendLatest("fish-1", map[string]any{"sequence": 3}) {
		t.Fatal("后续实时命令没有进入队列")
	}
	close(c.release)

	deadline := time.Now().Add(time.Second)
	for {
		c.mu.Lock()
		count := len(c.sent)
		var last map[string]any
		if count > 0 {
			last, _ = c.sent[count-1].(map[string]any)
		}
		snapshot := append([]any(nil), c.sent...)
		c.mu.Unlock()
		if count == 2 && last["sequence"] == 3 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("实时命令没有只保留最新待发送状态: %#v", snapshot)
		}
		time.Sleep(time.Millisecond)
	}
}
