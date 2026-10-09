import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const adapter = readFileSync(
  new URL("../public/competition/competition-adapter.js", import.meta.url),
  "utf8",
);

test("裁判端禁用循迹按钮会汇总原因并提供悬停提示", () => {
  assert.match(adapter, /function trackingStartBlockers\(workflow\)/);
  assert.match(adapter, /暂时不能启动循迹/);
  assert.match(adapter, /trackingStartTooltip/);
});

test("裁判端单鱼模式清除并忽略旧 Track ID", () => {
  assert.match(adapter, /video\.trackingMode === "single_fish"\) video\.trackingTrackId = null/);
  assert.match(adapter, /video\.trackingMode === "single_fish" \|\| session\.targetTrackId == null/);
});

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

test("非 trickle 信令等待 ICE 候选完成才提交 Offer", async () => {
  const begin = adapter.indexOf("  function waitForIce(peer) {");
  const end = adapter.indexOf("  function requestFallbackFrame() {", begin);
  assert.ok(begin >= 0 && end > begin);
  const timers = [];
  const waitForIce = runInNewContext(adapter.slice(begin, end) + "\nwaitForIce", {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  const peer = {
    iceGatheringState: "gathering",
    addEventListener(_name, callback) { this.changed = callback; },
    removeEventListener() {},
  };
  let completed = false;
  const pending = waitForIce(peer).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(timers[0].delay, 10000);
  peer.iceGatheringState = "complete";
  peer.changed();
  await pending;
  assert.equal(completed, true);

  const stalled = { iceGatheringState: "gathering", addEventListener() {}, removeEventListener() {} };
  const timedOut = waitForIce(stalled);
  timers[1].callback();
  await assert.rejects(timedOut, /ICE 候选收集超时/);
});

test("HTTPS 兼容画面在重绘和请求超时后继续轮询", async () => {
  const begin = adapter.indexOf("  function scheduleFallbackFrame(delay) {");
  const end = adapter.indexOf("  function startFrameFallback(reason) {", begin);
  assert.ok(begin >= 0 && end > begin);
  const timers = [];
  const requests = [];
  const revoked = [];
  function makeStage() { return { image: { src: "" }, querySelector() { return this.image; } }; }
  let stage = makeStage();
  let nextBlob = 0;
  const video = {
    fallback: true, sessionId: "session-1", connectionGeneration: 1,
    fallbackRequest: null, fallbackTimer: null, fallbackErrors: 0,
    fallbackElement: null, fallbackObjectUrl: null, lastFrameAt: 0,
  };
  class FakeAbortController {
    constructor() {
      this.listeners = [];
      this.signal = { addEventListener: (_name, callback) => this.listeners.push(callback) };
    }
    abort() { this.listeners.forEach((callback) => callback()); }
  }
  class FakeImage {
    set src(value) {
      this.value = value;
      this.naturalWidth = 640;
      this.naturalHeight = 480;
      queueMicrotask(() => this.onload?.());
    }
  }
  const requestFallbackFrame = runInNewContext(adapter.slice(begin, end) + "\nrequestFallbackFrame", {
    video, document: { hidden: false }, videoSurface: () => stage,
    mountVideoSurface: () => { video.fallbackElement = stage.image; },
    fetch: (_url, options) => new Promise((resolve, reject) => {
      requests.push({ resolve, reject });
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    AbortController: FakeAbortController, Image: FakeImage,
    URL: { createObjectURL: () => `blob:${++nextBlob}`, revokeObjectURL: (url) => revoked.push(url) },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    isRefereePage: () => false, setVisionStatus() {}, setBadge() {},
    lastDeviceBadge: null, renderCropEditor() {}, renderPlayerDetectionOverlay() {},
  });

  requestFallbackFrame();
  requestFallbackFrame();
  assert.equal(requests.length, 1, "only one image request may be active");
  stage = makeStage(); // The application rerendered the video stage.
  requests[0].resolve({ ok: true, blob: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stage.image.src, "blob:1", "decoded frame must attach to the new stage");
  const next = timers.find((timer) => timer.delay === 80 && !timer.cleared);
  assert.ok(next, "a successful frame must schedule another request");
  next.callback();
  assert.equal(requests.length, 2);
  const networkTimeout = timers.findLast((timer) => timer.delay === 6000 && !timer.cleared);
  networkTimeout.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(video.fallbackRequest, null);
  assert.equal(video.fallbackErrors, 1);
  assert.ok(timers.some((timer) => timer.delay === 400 && !timer.cleared));
  assert.deepEqual(revoked, []);
});
