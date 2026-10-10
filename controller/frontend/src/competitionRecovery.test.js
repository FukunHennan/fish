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
const refereePage = readFileSync(
  new URL("../public/competition/referee_interface.html", import.meta.url),
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

test("公网兼容画面优先使用持续连接，断开后改用 HTTPS 轮询", async () => {
  const begin = adapter.indexOf("  function startFrameFallback(reason) {");
  const end = adapter.indexOf("  function scheduleVideoReconnect(reason, delay) {", begin);
  assert.ok(begin >= 0 && end > begin);
  const sockets = [];
  const image = { src: "" };
  const stage = { querySelector: () => image };
  const statuses = [];
  let httpPolls = 0;
  const video = {
    sessionId: "session-1", connectionGeneration: 0, fallback: false,
    fallbackSocket: null, fallbackSocketTimer: null, fallbackObjectUrl: null,
    lastFrameAt: 0,
  };
  class FakeSocket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.onclose?.(); }
  }
  class FakeImage {
    set src(_value) { queueMicrotask(() => this.onload?.()); }
  }
  const context = {
    video, window: { WebSocket: FakeSocket }, location: { protocol: "https:", host: "fish.example" },
    Blob, Image: FakeImage,
    URL: { createObjectURL: () => "blob:frame", revokeObjectURL() {} },
    closeVideoPeer() { video.connectionGeneration++; video.fallback = false; },
    mountVideoSurface() {}, videoSurface: () => stage,
    requestFallbackFrame() { httpPolls++; },
    isRefereePage: () => false,
    setVisionStatus(value) { statuses.push(value); },
    setBadge() {}, lastDeviceBadge: null,
    renderCropEditor() {}, renderPlayerDetectionOverlay() {},
    setTimeout: () => 1, clearTimeout() {},
  };
  const startFrameFallback = runInNewContext(adapter.slice(begin, end) + "\nstartFrameFallback", context);
  startFrameFallback("WebRTC unavailable");
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /^wss:\/\/fish\.example\/api\/vision\/frame\.ws\?/);
  assert.equal(httpPolls, 0);
  sockets[0].onmessage({ data: new Blob([new Uint8Array([0xff, 0xd8])]) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(image.src, "blob:frame");
  assert.ok(statuses.some((value) => value.includes("实时通道")));
  sockets[0].close();
  assert.equal(httpPolls, 1);
  assert.equal(video.fallbackSocket, null);
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

test("曝光只在点击保存后提交，并等待相机确认写回", async () => {
  const renderStart = adapter.indexOf("  function renderCameraTelemetry() {");
  const renderEnd = adapter.indexOf("  function renderVideoControls() {", renderStart);
  const sessionStart = adapter.indexOf("  function applyVisionSession(session) {");
  const sessionEnd = adapter.indexOf("  function startVisionEvents() {", sessionStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart && sessionStart >= 0 && sessionEnd > sessionStart);
  assert.match(refereePage, /id="saveExposureBtn"/);
  assert.match(adapter, /saveExposure\.addEventListener\("click"/);
  assert.doesNotMatch(adapter, /exposureRange\.addEventListener\("change"/);

  const elements = {
    exposureRange: { value: "-6", disabled: false },
    exposureSetpoint: { textContent: "" },
    exposureValue: { textContent: "" },
    saveExposureBtn: { disabled: true },
    exposureSaveStatus: { textContent: "", dataset: {} },
  };
  const requests = [];
  const timers = [];
  const video = {
    sessionId: "session-1", metrics: { exposure: { supported: true, actualValue: -6, minimum: -13, maximum: -1, step: 1 } },
    exposureDesired: null, exposureDirty: false, exposureSaving: false,
    exposurePendingActionId: null, exposurePendingValue: null,
    exposureSaveTimeout: null, exposureSaveMessage: "调整后点击保存", exposureSaveTone: "info",
    rotationDraft: null, cropDirty: false, cropDragging: false, overlays: {},
  };
  const controls = runInNewContext(
    adapter.slice(renderStart, renderEnd) + adapter.slice(sessionStart, sessionEnd) +
      "\n({ renderCameraTelemetry, applyCameraExposure, applyVisionSession })",
    {
      video,
      document: { querySelector: () => null, getElementById: (id) => elements[id] || null },
      finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; },
      formatNumber: String,
      normalizeCropRegion: () => null, normalizeRotation: () => null,
      renderCropEditor() {}, renderRotationControls() {}, renderVideoControls() {}, renderPlayerDetectionOverlay() {},
      setVisionStatus() {}, refreshVisionSession: async () => {},
      api(path, options) { requests.push({ path, options }); return Promise.resolve({ accepted: true }); },
      setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
      clearTimeout(timer) { timer.cleared = true; },
    },
  );
  controls.renderCameraTelemetry();
  assert.equal(elements.saveExposureBtn.disabled, true);
  video.exposureDesired = -3;
  video.exposureDirty = true;
  video.exposureSaveMessage = "尚未保存 · 点击保存曝光";
  elements.exposureRange.value = "-3";
  controls.renderCameraTelemetry();
  assert.equal(requests.length, 0, "拖动滑块不应立即提交");
  assert.equal(elements.saveExposureBtn.disabled, false);
  await controls.applyCameraExposure(elements.exposureRange.value);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.body.type, "camera.exposure");
  assert.equal(requests[0].options.body.value, -3);
  assert.equal(elements.saveExposureBtn.disabled, true, "等待确认时不得重复提交");
  assert.equal(elements.exposureRange.disabled, true, "等待确认时不得修改待保存值");
  timers.find((timer) => timer.delay === 350).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(timers.some((timer) => timer.delay === 700), "SSE 延迟时仍应轮询确认结果");
  const actionId = requests[0].options.body.actionId;
  controls.applyVisionSession({
    sessionId: "session-1", state: "previewing",
    metrics: { exposure: { supported: true, actualValue: -3 } },
    lastAction: { actionId, status: "completed", actualValue: -3 },
  });
  assert.equal(video.exposureDirty, false);
  assert.equal(video.exposureSaving, false);
  assert.equal(elements.exposureRange.disabled, false);
  assert.match(elements.exposureSaveStatus.textContent, /已保存至 program\.json/);
  assert.equal(elements.exposureRange.value, "-3");
  assert.ok(timers.some((timer) => timer.delay === 12000 && timer.cleared));
  assert.ok(timers.some((timer) => timer.delay === 700 && timer.cleared));

  video.exposureDesired = -2;
  video.exposureDirty = true;
  elements.exposureRange.value = "-2";
  await controls.applyCameraExposure("-2");
  controls.applyVisionSession({
    sessionId: "session-1", state: "previewing",
    metrics: { exposure: { supported: true, actualValue: -3 } },
    lastAction: { actionId: requests[1].options.body.actionId, status: "failed", errorCode: "exposure_not_applied" },
  });
  assert.equal(video.exposureDirty, true);
  assert.equal(elements.exposureRange.disabled, false);
  assert.equal(elements.saveExposureBtn.disabled, false, "相机拒绝时允许重新保存");
  assert.match(elements.exposureSaveStatus.textContent, /保存失败/);
  await controls.applyCameraExposure("-2");
  controls.applyVisionSession({
    sessionId: "session-1", state: "previewing",
    metrics: { exposure: { supported: true, actualValue: -3 } },
    lastAction: { actionId: requests[2].options.body.actionId, status: "completed", actualValue: null },
  });
  assert.equal(video.exposureDirty, true, "没有相机实际值时不得显示保存成功");
  assert.match(elements.exposureSaveStatus.textContent, /保存失败/);
});
