import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceStateSignature,
  keyboardMode,
  mergeDevicesInStableOrder,
} from "./deviceState.js";

const pressed = (...keys) => new Set(keys);
const turnOrder = (...entries) => new Map(entries);

test("W+A 和 W+D 按最新转向，松开当前转向后回到前进", () => {
  assert.equal(keyboardMode(pressed("KeyW", "KeyA"), turnOrder(["KeyA", 1])), "left");
  assert.equal(keyboardMode(pressed("KeyW", "KeyD"), turnOrder(["KeyD", 1])), "right");
  assert.equal(keyboardMode(pressed("KeyW")), "forward");
  assert.equal(
    keyboardMode(pressed("KeyW", "KeyA", "KeyD"), turnOrder(["KeyA", 1], ["KeyD", 2])),
    "right",
  );
  assert.equal(keyboardMode(pressed("KeyW"), turnOrder(["KeyA", 1], ["KeyD", 2])), "forward");
});

test("没有前进键时按下顺序决定左右转", () => {
  assert.equal(keyboardMode(pressed("KeyA", "KeyD"), turnOrder(["KeyA", 1], ["KeyD", 2])), "right");
  assert.equal(keyboardMode(pressed("KeyA", "KeyD"), turnOrder(["KeyA", 2], ["KeyD", 1])), "left");
});

test("停止键优先级高于其他运动键", () => {
  assert.equal(keyboardMode(pressed("KeyW", "KeyS")), "stop");
  assert.equal(keyboardMode(pressed("KeyW", "Space")), "stop");
});

test("设备状态更新保留后端顺序，新设备追加到末尾", () => {
  assert.deepEqual(
    mergeDevicesInStableOrder([], [
      { deviceId: "fish-c" },
      { deviceId: "fish-a" },
      { deviceId: "fish-b" },
    ]).map((device) => device.deviceId),
    ["fish-c", "fish-a", "fish-b"],
  );

  const previous = [{ deviceId: "fish-b" }, { deviceId: "fish-a" }];
  const incoming = [
    { deviceId: "fish-a", lease: { ownerEmail: "operator@example.com" } },
    { deviceId: "fish-b", mode: 2 },
    { deviceId: "fish-c" },
  ];
  assert.deepEqual(
    mergeDevicesInStableOrder(previous, incoming).map((device) => device.deviceId),
    ["fish-b", "fish-a", "fish-c"],
  );
});

test("心跳字段和租约时间变化不构成界面状态变化", () => {
  const base = {
    deviceId: "fish-1",
    mode: 2,
    lastSeen: "2026-09-03T00:00:00Z",
    uptimeMs: 100,
    lastControlMs: 90,
    batterySampleAgeMs: 10,
    rssi: -40,
    visionActive: true,
    visionSessionId: "session-1",
    visionSequence: 1,
    lease: {
      deviceId: "fish-1",
      ownerId: "user-1",
      ownerEmail: "operator@example.com",
      expiresAt: "2026-09-03T00:00:01Z",
      lastCommandAt: "2026-09-03T00:00:00Z",
    },
  };
  const heartbeat = {
    ...base,
    lastSeen: "2026-09-03T00:00:01Z",
    uptimeMs: 200,
    lastControlMs: 190,
    batterySampleAgeMs: 20,
    rssi: -65,
    visionSequence: 2,
    lease: { ...base.lease, expiresAt: "2026-09-03T00:00:02Z", lastCommandAt: "2026-09-03T00:00:01Z" },
  };
  assert.equal(deviceStateSignature([base]), deviceStateSignature([heartbeat]));
  assert.notEqual(
    deviceStateSignature([base]),
    deviceStateSignature([{ ...base, mode: 3 }]),
  );
});
