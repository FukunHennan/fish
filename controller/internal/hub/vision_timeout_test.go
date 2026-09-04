package hub

import (
	"testing"
	"time"
)

func visionTestMessage(mode string) map[string]any {
	return map[string]any{"type": "command", "command": "motion.set", "payload": map[string]any{"mode": mode, "controlSource": "vision-bot"}}
}

func testVisionEntry() (*Hub, *entry) {
	h := New()
	e := &entry{outboundWake: make(chan struct{}, 1)}
	h.entries["fish"] = e
	return h, e
}

func TestVisionTimeoutDropsStaleQueuedMotionAndStopsOnce(t *testing.T) {
	h, e := testVisionEntry()
	done := make(chan error, 1)
	e.enqueueWithMotionTimeout(visionTestMessage("forward"), done, time.Second)
	expires := e.visionDeadline
	e.enqueue(map[string]any{"type": "heartbeat"}, nil)
	if e.visionDeadline != expires {
		t.Fatal("heartbeat changed vision deadline")
	}
	if len(h.StopExpiredVisionMotion(expires.Add(-time.Nanosecond))) != 0 {
		t.Fatal("stopped too early")
	}
	if len(h.StopExpiredVisionMotion(expires)) != 1 {
		t.Fatal("missing stop")
	}
	if len(h.StopExpiredVisionMotion(expires.Add(time.Second))) != 0 {
		t.Fatal("duplicate stop")
	}
	if err := <-done; err != errMotionExpired {
		t.Fatalf("pending motion result=%v", err)
	}
	if e.popNext().value.(map[string]any)["type"] != "heartbeat" {
		t.Fatal("heartbeat was discarded")
	}
	payload := e.popNext().value.(map[string]any)["payload"].(map[string]any)
	if payload["mode"] != "stop" || payload["amplitude"] != 0.0 || payload["bias"] != 0.0 {
		t.Fatalf("unsafe timeout stop: %v", payload)
	}
	if e.popNext() != nil {
		t.Fatal("stale command remained queued")
	}
}

func TestFreshVisionMotionRenewsDeadline(t *testing.T) {
	h, e := testVisionEntry()
	e.enqueueWithMotionTimeout(visionTestMessage("forward"), nil, time.Second)
	oldDeadline := e.visionDeadline
	e.enqueueWithMotionTimeout(visionTestMessage("left"), nil, 2*time.Second)
	if len(h.StopExpiredVisionMotion(oldDeadline)) != 0 {
		t.Fatal("renewed motion stopped at old deadline")
	}
	if len(h.StopExpiredVisionMotion(e.visionDeadline)) != 1 {
		t.Fatal("renewed motion never expired")
	}
}

func TestReplacingMotionCancelsOldVisionTimeout(t *testing.T) {
	for _, command := range []string{"motion.set", "emergency.stop", "ota.start"} {
		t.Run(command, func(t *testing.T) {
			h, e := testVisionEntry()
			e.enqueueWithMotionTimeout(visionTestMessage("forward"), nil, time.Second)
			expires := e.visionDeadline
			e.enqueue(map[string]any{"command": command}, nil)
			if len(h.StopExpiredVisionMotion(expires)) != 0 {
				t.Fatal("old timeout affected replacement")
			}
		})
	}
	h, e := testVisionEntry()
	e.enqueueWithMotionTimeout(visionTestMessage("forward"), nil, time.Second)
	expires := e.visionDeadline
	e.latestSequence = 5
	if e.enqueueLatest(4, visionTestMessage("stop")) {
		t.Fatal("accepted old sequence")
	}
	if len(h.StopExpiredVisionMotion(expires)) != 1 {
		t.Fatal("rejected command disabled safety timeout")
	}
	e.enqueueWithMotionTimeout(visionTestMessage("forward"), nil, time.Second)
	expires = e.visionDeadline
	if !e.enqueueLatest(6, visionTestMessage("right")) {
		t.Fatal("keyboard takeover rejected")
	}
	if len(h.StopExpiredVisionMotion(expires)) != 0 {
		t.Fatal("timeout affected keyboard takeover")
	}
}

func TestVisionTimeoutDoesNotAffectOtherDevices(t *testing.T) {
	h, e := testVisionEntry()
	other := &entry{outboundWake: make(chan struct{}, 1)}
	h.entries["other"] = other
	e.enqueueWithMotionTimeout(visionTestMessage("forward"), nil, time.Second)
	other.enqueueWithMotionTimeout(visionTestMessage("forward"), nil, time.Minute)
	expires := e.visionDeadline
	e.enqueue(map[string]any{"command": "rgb.set"}, nil)
	h.Update("fish", map[string]any{"mode": 2.0})
	stopped := h.StopExpiredVisionMotion(expires)
	if len(stopped) != 1 || stopped[0] != "fish" {
		t.Fatalf("expired devices=%v", stopped)
	}
}

func TestLostAckStillArmsVisionTimeout(t *testing.T) {
	h := New()
	c := &fakeConn{}
	h.Register(Device{ID: "fish"}, c)
	defer h.Remove("fish", c)
	_, sent, ack := h.SendAndWaitWithMotionTimeout("fish", "lost-ack", visionTestMessage("forward"), time.Millisecond, time.Second)
	if !sent || ack {
		t.Fatalf("sent=%v ack=%v", sent, ack)
	}
	if len(h.StopExpiredVisionMotion(time.Now().Add(2*time.Second))) != 1 {
		t.Fatal("lost ACK disabled stop")
	}
}

func TestWriterDoesNotDeliverExpiredMotion(t *testing.T) {
	_, e := testVisionEntry()
	done := make(chan error, 1)
	e.enqueueWithMotionTimeout(visionTestMessage("forward"), done, time.Second)
	e.outbound[0].motionExpires = time.Now().Add(-time.Second)
	if e.popNext() != nil {
		t.Fatal("writer would deliver expired motion")
	}
	if err := <-done; err != errMotionExpired {
		t.Fatalf("expired result=%v", err)
	}
}
