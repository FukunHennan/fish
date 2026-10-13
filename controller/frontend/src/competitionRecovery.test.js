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
  assert.match(adapter, /element\.addEventListener\("error"/);
  assert.match(adapter, /画面超过 5 秒未更新/);
  assert.match(adapter, /视频首帧超时/);
  assert.match(adapter, /event\.track\.onended/);
});

test("绑定新媒体流的 emptied/stalled 事件不触发 TURN 重连", () => {
  const begin = adapter.indexOf("  function watchVideoFrames(element) {");
  const end = adapter.indexOf("  function removeVideoBackdrop() {", begin);
  const listeners = {};
  const stream = {};
  const element = { srcObject: stream, isConnected: true, error: null, addEventListener: (name, callback) => { listeners[name] = callback; } };
  const video = { peer: {}, stream, frameElement: null, frameCallbackId: null, frameWatchTimer: 1 };
  const interruptions = [];
  let frames = 0;
  const watch = runInNewContext(adapter.slice(begin, end) + "\nwatchVideoFrames", {
    video,
    markVideoFrame: () => { frames += 1; },
    startFrameFallback: reason => interruptions.push(reason),
  });
  watch(element);
  listeners.emptied?.();
  listeners.stalled?.();
  listeners.error();
  assert.equal(interruptions.length, 0);
  listeners.playing();
  assert.equal(frames, 1);
  element.error = { code: 3 };
  element.srcObject = null;
  listeners.error();
  listeners.timeupdate();
  assert.equal(interruptions.length, 0);
  assert.equal(frames, 1);
  element.srcObject = stream;
  listeners.error();
  assert.equal(interruptions.length, 1);
  assert.match(interruptions[0], /解码错误/);
  video.frameElement = {};
  listeners.error();
  assert.equal(interruptions.length, 1);
});

test("尚未取得的视频指标显示为空，真实零值保持为零", () => {
  const begin = adapter.indexOf("  function finiteNumber(value) {");
  const end = adapter.indexOf("  function formatNumber(value) {", begin);
  const finite = runInNewContext(adapter.slice(begin, end) + "\nfiniteNumber");
  for (const value of [null, undefined, "", " ", NaN]) assert.equal(finite(value), null);
  assert.equal(finite(0), 0);
  assert.equal(finite("0"), 0);
});

test("裁判切换视图更新现有连接且不重复提交", async () => {
  const begin = adapter.indexOf("  function updateVideoView() {");
  const end = adapter.indexOf("  function ensureVideoSurface() {", begin);
  const peer = {};
  const video = { peer, peerId: "owned", requestedView: "full", connectionGeneration: 1 };
  const requests = [];
  const update = runInNewContext(adapter.slice(begin, end) + "\nupdateVideoView", {
    video, competitionVideoView: () => "cropped", videoSurface: () => ({}),
    api: (_url, request) => { requests.push(request.body); return Promise.resolve(); },
    setVisionStatus() {},
  });
  update();
  update();
  assert.equal(requests.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(video.peer, peer);
  assert.equal(video.requestedView, "cropped");
  assert.equal(requests[0].peerId, "owned");
  update();
  assert.equal(requests.length, 1);
});

test("切换场地复用正在播放的视频元素与媒体流", () => {
  const begin = adapter.indexOf("  function mountVideoSurface() {");
  const end = adapter.indexOf("  function cameraText(camera, index) {", begin);
  const stream = {};
  const element = { srcObject: stream };
  let moved = null;
  let watched = null;
  const stage = { querySelector: () => null, firstChild: null, insertBefore: node => { moved = node; } };
  const mount = runInNewContext(adapter.slice(begin, end) + "\nmountVideoSurface", {
    video: { frameElement: element, stream },
    videoSurface: () => stage, removeVideoBackdrop() {}, ensureVideoControls() {},
    isRefereePage: () => true, watchVideoFrames: node => { watched = node; },
    renderCropEditor() {}, renderPlayerDetectionOverlay() {},
    document: { createElement: () => { throw new Error("must reuse video"); } },
  });
  mount();
  assert.equal(moved, element);
  assert.equal(watched, element);
  assert.equal(element.srcObject, stream);
});

test("WebRTC 诊断按采样区间计算丢包率、接收帧率和解码丢帧", () => {
  const begin = adapter.indexOf("  function calculateVideoIntervalStats(");
  const end = adapter.indexOf("  function startVideoStats(", begin);
  assert.ok(begin >= 0 && end > begin);
  const calculate = runInNewContext(adapter.slice(begin, end) + "\ncalculateVideoIntervalStats");
  const previous = {
    at: 1000, bytesReceived: 1000, packetsReceived: 100, packetsLost: 10,
    framesReceived: 30, framesDecoded: 28, framesDropped: 2,
    jitterBufferDelay: 2, jitterBufferEmittedCount: 20,
  };
  const current = {
    at: 3000, bytesReceived: 251000, packetsReceived: 280, packetsLost: 20,
    framesReceived: 70, framesDecoded: 58, framesDropped: 7,
    jitterBufferDelay: 5, jitterBufferEmittedCount: 50,
  };
  const stats = calculate(current, previous);
  assert.equal(stats.bitrateKbps, 1000);
  assert.equal(stats.receiveFps, 20);
  assert.equal(stats.fps, 15);
  assert.equal(stats.packetLossPct, 10 / 190 * 100);
  assert.equal(stats.packetsLostInterval, 10);
  assert.equal(stats.framesDroppedInterval, 5);
  assert.equal(stats.bufferMs, 100);
  assert.equal(calculate({ ...current, jitterBufferEmittedCount: 20 }, previous).bufferMs, null);
  assert.equal(stats.intervalSeconds, 2);
  assert.equal(calculate(current, null), null);
  assert.equal(calculate({ ...current, packetsLost: 5 }, previous).packetLossPct, null);
});

test("公网 WebRTC 诊断展示浏览器与服务端候选及 TURN 传输协议", () => {
  assert.ok(adapter.includes("selectedPair.remoteCandidateId"));
  assert.ok(adapter.includes('localCandidateType + "/" + remoteCandidateType'));
  assert.ok(adapter.includes("relayProtocol = (localCandidate && localCandidate.relayProtocol)"));
  assert.ok(adapter.includes('config.turnRequired || config.iceTransportPolicy === "relay"'));
});

test("选手实时画面只解码一条视频流并清理旧背景副本", () => {
  assert.match(adapter, /function removeVideoBackdrop\(\)[\s\S]*?element\.pause\(\)[\s\S]*?element\.srcObject = null[\s\S]*?element\.remove\(\)/);
  const begin = adapter.indexOf("  function mountVideoSurface() {");
  const end = adapter.indexOf("  function cameraText(camera, index) {", begin);
  assert.ok(begin >= 0 && end > begin);
  const mount = adapter.slice(begin, end);
  assert.match(mount, /removeVideoBackdrop\(\)/);
  assert.doesNotMatch(mount, /data-fish-video-backdrop|backdrop\.srcObject/);
  assert.doesNotMatch(playerPage, /video\[data-fish-video-backdrop\].*blur/i);
});

test("非 trickle 信令等待 ICE 候选完成才提交 Offer", async () => {
  const begin = adapter.indexOf("  function waitForIce(peer) {");
  const end = adapter.indexOf("  function competitionVideoView() {", begin);
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

test("TURN 连接失败只重试 WebRTC，不启动备用媒体通道", () => {
  const begin = adapter.indexOf("  function startFrameFallback(reason) {");
  const end = adapter.indexOf("  function scheduleVideoReconnect(reason, delay) {", begin);
  const retries = [];
  const retry = runInNewContext(adapter.slice(begin, end) + "\nstartFrameFallback", {
    video: { sessionId: "session-1" },
    scheduleVideoReconnect: (reason, delay) => retries.push({ reason, delay }),
  });
  retry("连接中断");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].delay, 3000);
  assert.match(retries[0].reason, /TURN/);
  assert.doesNotMatch(adapter, /function requestFallbackFrame|function startFrameSocket/);
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
  assert.match(adapter, /quality: "smooth"/);
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
