import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const adapter = readFileSync(
  new URL("../public/competition/competition-adapter.js", import.meta.url),
  "utf8",
);
const playerPage = readFileSync(
  new URL("../public/competition/player_interface.html", import.meta.url),
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

test("选手租约在空闲时持续续期并能重新申请", () => {
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

test("选手端结束比赛后保持控制并按账号领取一次通知", async () => {
  const begin = adapter.indexOf("  function setPlayerMatchHud(match, elapsedMs) {");
  const end = adapter.indexOf("  function refreshPlayerMatch() {", begin);
  assert.ok(begin >= 0 && end > begin);
  const events = [];
  const nodes = new Map();
  function elements(selector) {
    if (!nodes.has(selector)) nodes.set(selector, [{ textContent: "", dataset: {} }]);
    return nodes.get(selector);
  }
  function value(selector) { return elements(selector)[0]; }
  const activeMotion = { b1: { action: "forward" } };
  const requests = [];
  let claimShow = true;
  const state = { match: null, user: { email: "1" } };
  const context = {
    isRefereePage: () => false, dismissedFinishedMatchId: null,
    state, document: {
      body: { dataset: {} }, querySelectorAll: elements,
      dispatchEvent: (event) => events.push(event),
    },
    window: {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    syncPlayerReadiness() {}, currentTeamSide: () => "blue",
    stateText: (state) => ({ running: "进行中", finished: "已结束" })[state] || state,
    fmtClock: (elapsed) => elapsed ? "00:10" : "00:00",
    PLAYERS: ["b1", "b2"], activeMotion,
    api(path, options) { requests.push({ path, options }); return Promise.resolve({ show: claimShow }); },
    finishedMatchEventId: null,
  };
  const paint = runInNewContext(adapter.slice(begin, end) + "\npaintPlayerMatch", context);
  const match = {
    id: "match-1", matchNo: "第 1 场", state: "running", fieldLocked: false,
    blue: { name: "蓝队", score: 2 }, red: { name: "红队", score: 1 },
  };
  paint({ match, elapsedMs: 9000 });
  assert.equal(events.length, 0);
  assert.equal(value("[data-live-timer-state]").dataset.state, "running");
  assert.equal(value("[data-live-timer-state-text]").textContent, "比赛中");
  paint({ match: { ...match, state: "finished" }, elapsedMs: 10000 });
  paint({ match: { ...match, state: "finished" }, elapsedMs: 10000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(activeMotion.b1, "比赛结束不得打断已有运动控制");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/competition/match/finish-notice");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "fish-match-finished");
  assert.equal(events[0].detail.blueScore, 2);
  assert.equal(context.document.body.dataset.fishMatchState, "finished");
  assert.equal(value("[data-live-timer-state]").dataset.state, "idle");
  assert.equal(value("[data-live-timer-state-text]").textContent, "已结束");
  assert.equal(value("[data-live-blue-score]").textContent, "2");
  context.window.fishCompetitionDismissFinishedNotice("match-1");
  assert.equal(value("[data-live-blue-score]").textContent, "0");
  assert.equal(value("[data-live-red-score]").textContent, "0");
  assert.equal(value("[data-live-match-clock]").textContent, "00:00");
  paint({ match: { ...match, state: "finished" }, elapsedMs: 10000 });
  assert.equal(value("[data-live-blue-score]").textContent, "0", "轮询不得恢复已清除比分");
  assert.equal(value("[data-live-match-clock]").textContent, "00:00", "轮询不得恢复已清除计时");
  paint({ match: null, elapsedMs: 0 });
  assert.equal(value("[data-live-timer-state-text]").textContent, "暂无比赛");
  paint({ match: { ...match, id: "match-2", state: "running" }, elapsedMs: 9000 });
  assert.equal(value("[data-live-blue-score]").textContent, "2", "新比赛应显示新比分");
  assert.equal(value("[data-live-timer-state]").dataset.state, "running");
  claimShow = false;
  paint({ match: { ...match, id: "match-2", state: "finished" }, elapsedMs: 10000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value("[data-live-blue-score]").textContent, "0", "已领取提示的刷新页面不应显示旧比分");
  assert.equal(value("[data-live-match-clock]").textContent, "00:00");
  assert.equal(events.length, 1, "已领取提示的账号不能重复弹窗");
  assert.match(playerPage, /id="matchFinishedNotice"[\s\S]*?data-finish-records/);
  assert.match(playerPage, /addEventListener\('fish-match-finished'/);
  assert.match(adapter, /quality: isRefereePage\(\) \? "full" : "smooth"/);
});

test("比赛结束提示显示比分，关闭后不被轮询重复打开", () => {
  const begin = playerPage.indexOf("  const finishedNotice = document.getElementById('matchFinishedNotice');");
  const end = playerPage.indexOf("  const DEFAULT_KEY_BINDINGS = {", begin);
  assert.ok(begin >= 0 && end > begin);
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      textContent: "", listeners: {}, focus() { this.focused = true; },
      addEventListener(type, handler) { this.listeners[type] = handler; },
    });
    return nodes.get(selector);
  }
  const notice = {
    hidden: true, listeners: {}, querySelector: node,
    addEventListener(type, handler) { this.listeners[type] = handler; },
  };
  const listeners = {};
  const window = { location: { hash: "#control" } };
  const dismissed = [];
  window.fishCompetitionDismissFinishedNotice = (matchId) => dismissed.push(matchId);
  let stoppedPrograms = 0;
  let releasedKeys = 0;
  runInNewContext(playerPage.slice(begin, end), {
    document: {
      getElementById: () => notice,
      addEventListener: (type, handler) => { listeners[type] = handler; },
    },
    window,
    stopAutoSimulation() { stoppedPrograms += 1; },
    releaseAllActiveControlKeys() { releasedKeys += 1; },
  });
  const detail = {
    matchId: "match-1", account: "1", matchNo: "第一场", blueName: "蓝队", redName: "红队",
    blueScore: 2, redScore: 1, elapsedMs: 10000,
  };
  listeners["fish-match-finished"]({ detail });
  assert.equal(notice.hidden, false);
  assert.equal(stoppedPrograms, 0);
  assert.equal(releasedKeys, 0);
  assert.equal(node("[data-finish-score]").textContent, "2 : 1");
  assert.match(node("[data-finish-summary]").textContent, /00:10/);
  node("[data-finish-close]").listeners.click();
  assert.deepEqual(dismissed, ["match-1"]);
  listeners["fish-match-finished"]({ detail });
  assert.equal(notice.hidden, true);
  listeners["fish-match-finished"]({ detail: { ...detail, matchId: "match-2" } });
  assert.equal(notice.hidden, false);
  node("[data-finish-records]").listeners.click();
  assert.equal(window.location.hash, "records");
  assert.deepEqual(dismissed, ["match-1", "match-2"]);
});
