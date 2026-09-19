import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = readFileSync(
  new URL("../public/competition/competition-adapter.js", import.meta.url),
  "utf8",
);

test("锁场后的选手租约在空闲时持续续期并能重新申请", () => {
  assert.match(adapter, /function renew\(deviceId\)[\s\S]*?method: "PATCH"/);
  assert.match(adapter, /function startPlayerLeaseMaintenance[\s\S]*?setInterval\(maintainPlayerLeases, 15000\)/);
  assert.match(adapter, /error\.status === 409[\s\S]*?acquire\(deviceId, slotForPlayer\(player\)\)/);
  assert.match(adapter, /visibilitychange[\s\S]*?schedulePlayerLeaseRefresh\(50\)/);
});

test("设备失联会停止本地续发并在设备恢复后重新绑定", () => {
  assert.match(adapter, /设备已离线[\s\S]*?schedulePlayerLeaseRefresh\(300\)/);
  assert.match(adapter, /heldInputs\[player\] = \{\};[\s\S]*?endMotion\(player\);[\s\S]*?delete state\.bound\[player\]/);
});

test("WebRTC 连接假在线但无新帧时主动重连", () => {
  assert.match(adapter, /requestVideoFrameCallback/);
  assert.match(adapter, /\["error", "stalled", "emptied"\]/);
  assert.match(adapter, /画面超过 5 秒未更新/);
  assert.match(adapter, /视频首帧超时/);
  assert.match(adapter, /event\.track\.onended/);
});
