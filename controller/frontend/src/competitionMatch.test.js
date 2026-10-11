import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const adapter = readFileSync(
  new URL("../public/competition/competition-adapter.js", import.meta.url),
  "utf8",
);
const refereePage = readFileSync(
  new URL("../public/competition/referee_interface.html", import.meta.url),
  "utf8",
);
const playerPage = readFileSync(
  new URL("../public/competition/player_interface.html", import.meta.url),
  "utf8",
);
const replayTransport = readFileSync(
  new URL("../public/competition/replay-transport.js", import.meta.url),
  "utf8",
);

test("裁判比赛画面与选手端均使用有效区，场地调整保留全画面", () => {
  const begin = adapter.indexOf("  function competitionVideoView() {");
  const end = adapter.indexOf("  function waitForIce(", begin);
  assert.ok(begin >= 0 && end > begin);
  let referee = true;
  let matchVisible = false;
  const videoView = runInNewContext(adapter.slice(begin, end) + "\ncompetitionVideoView", {
    isRefereePage: () => referee,
    document: { getElementById: () => ({ classList: { contains: () => !matchVisible } }) },
  });
  assert.equal(videoView(), "full");
  matchVisible = true;
  assert.equal(videoView(), "cropped");
  referee = false;
  assert.equal(videoView(), "cropped");
  assert.match(refereePage, /id="showMatchRuler"/);
  assert.match(refereePage, /id="matchFieldRulerCanvas"/);
});

test("实时计分列表显示事件并在下一场清空", () => {
  const begin = adapter.indexOf("  function paintRefereeScoreEvents(match) {");
  const end = adapter.indexOf("  function paintReferee() {", begin);
  assert.ok(begin >= 0 && end > begin);
  const list = { dataset: {}, innerHTML: "" };
  const paint = runInNewContext(adapter.slice(begin, end) + "\npaintRefereeScoreEvents", {
    document: { getElementById: () => list },
    fmtClock: (milliseconds) => `${milliseconds / 1000}s`,
    escapeHtml: (value) => value,
  });
  paint({ id: "match-1", durationMs: 300000, events: [
    { at: "2026-10-10T22:00:00+08:00", elapsedMs: 10000, side: "blue", label: "进球", delta: 10 },
    { at: "2026-10-10T22:00:01+08:00", elapsedMs: 11000, side: "red", label: "越界", delta: -2 },
  ] });
  assert.match(list.innerHTML, /红队 · 越界/);
  assert.match(list.innerHTML, /蓝队 · 进球/);
  assert.match(list.innerHTML, /\+10/);
  assert.match(list.innerHTML, /289s/);
  paint({ id: "match-2", durationMs: 300000, events: [] });
  assert.match(list.innerHTML, /暂无计分事件/);
});

test("历史记录保留逐条事件，并允许通过 TURN 定位与下载", () => {
  const begin = refereePage.indexOf("window.applyCompetitionRecords=function(records){");
  const end = refereePage.indexOf("search.oninput=", begin);
  assert.ok(begin >= 0 && end > begin);
  const history = [];
  const context = {
    window: {}, history, historySelected: null,
    fmtMs: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    renderHistory() {}, renderHistoryDetail() {},
  };
  runInNewContext(refereePage.slice(begin, end), context);
  context.window.applyCompetitionRecords([{
    id: "match-1", durationMs: 300000, elapsedMs: 20000,
    blueName: "蓝队", redName: "红队", blueScore: 10, redScore: 2,
    events: [
      { elapsedMs: 5000, at: "2026-10-10T22:00:05+08:00", side: "blue", kind: "goal", label: "进球", delta: 10 },
      { elapsedMs: 15000, at: "2026-10-10T22:00:15+08:00", side: "red", kind: "assist", label: "配合", delta: 2 },
    ],
  }]);
  assert.equal(history[0].events.length, 2);
  assert.equal(history[0].events[0][0], "295s");
  assert.equal(history[0].events[0][3], "进球");
  assert.equal(history[0].events[0][4], "+10");
  assert.equal(history[0].events[0][5], 5000);
  assert.equal(history[0].blue.g, 1);
  assert.equal(history[0].red.a, 1);

  assert.match(refereePage, /id="replaySeek" type="range"/);
  assert.match(refereePage, /data-replay-ms=/);
  assert.match(refereePage, /function playReplayAt\(requestedMs\)/);
  assert.match(refereePage, /class="scoreEvent[^`]*<span>\$\{e\[0\]\}<\/span>/);
  assert.doesNotMatch(refereePage, /id="groupFilter"/);
  assert.doesNotMatch(refereePage, /data-record-tab=/);
  assert.doesNotMatch(refereePage, /id="replayEvents"/);
  assert.doesNotMatch(refereePage, /id="replayVideo" controls/);
  assert.doesNotMatch(playerPage, /id="studentReplayVideo" controls/);
  assert.match(refereePage, /FishReplayTransport\.download/);
  assert.match(playerPage, /FishReplayTransport\.download/);
  assert.match(replayTransport, /iceTransportPolicy: 'relay'/);
});

test("旧比赛重复 ID 仍能区分记录，不显示无用的缺失提示", () => {
  const begin = refereePage.indexOf("window.applyCompetitionRecords=function(records){");
  const end = refereePage.indexOf("search.oninput=", begin);
  const history = [];
  const context = {
    window: {}, history, historySelected: null,
    fmtMs: () => "00:00", renderHistory() {}, renderHistoryDetail() {},
  };
  runInNewContext(refereePage.slice(begin, end), context);
  context.window.applyCompetitionRecords([
    { id: "same-match", finishedAt: "2026-10-10T19:41:13+08:00" },
    { id: "same-match", finishedAt: "2026-10-10T13:37:26+08:00" },
  ]);
  assert.notEqual(history[0].id, history[1].id);
  assert.equal(history[0].hasEventLog, false);
  assert.doesNotMatch(refereePage, /旧比赛未保存逐条计分事件/);
});

test("队伍搜索只匹配队名，录像事件使用录制时间而非暂停后的比赛计时", () => {
  const filterBegin = refereePage.indexOf("function filteredHistory(){");
  const filterEnd = refereePage.indexOf("function renderHistory(){", filterBegin);
  assert.ok(filterBegin >= 0 && filterEnd > filterBegin);
  const search = { value: "第二队" };
  const filterHistory = [
    { blue: { team: "第一队" }, red: { team: "第二队" }, no: "第一场" },
    { blue: { team: "第三队" }, red: { team: "第四队" }, no: "第二队杯" },
  ];
  const filteredHistory = runInNewContext(
    refereePage.slice(filterBegin, filterEnd) + "\nfilteredHistory",
    { history: filterHistory, search },
  );
  assert.equal(filteredHistory().length, 1);
  assert.equal(filteredHistory()[0].blue.team, "第一队");

  const begin = refereePage.indexOf("window.applyCompetitionRecords=function(records){");
  const end = refereePage.indexOf("search.oninput=", begin);
  const history = [];
  const context = {
    window: {}, history, historySelected: null,
    fmtMs: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    renderHistory() {}, renderHistoryDetail() {},
  };
  runInNewContext(refereePage.slice(begin, end), context);
  context.window.applyCompetitionRecords([{
    id: "paused-match", startedAt: "2026-10-10T22:00:01+08:00",
    recordingStartedAt: "2026-10-10T22:00:00+08:00",
    videoDurationMs: 30000,
    events: [{ at: "2026-10-10T22:00:20+08:00", elapsedMs: 5000, side: "blue", kind: "goal", label: "进球", delta: 10 }],
  }]);
  assert.equal(history[0].events[0][5], 20000);
  assert.equal(history[0].events[0][0], "175s");
});

test("归档后选手看到新一场零分，同时领取上一场结束通知", async () => {
  const begin = adapter.indexOf("  function setPlayerMatchHud(match, elapsedMs) {");
  const end = adapter.indexOf("  function refreshPlayerMatch() {", begin);
  assert.ok(begin >= 0 && end > begin);
  const nodes = new Map();
  const events = [];
  const requests = [];
  function elements(selector) {
    if (!nodes.has(selector)) nodes.set(selector, [{ textContent: "", dataset: {} }]);
    return nodes.get(selector);
  }
  const state = { match: null, user: { email: "player@example.com" } };
  const context = {
    state, isRefereePage: () => false,
    document: {
      body: { dataset: {} }, querySelectorAll: elements,
      dispatchEvent: (event) => events.push(event),
    },
    window: {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    syncPlayerReadiness() {}, currentTeamSide: () => "blue",
    stateText: (value) => value, fmtClock: () => "00:00",
    api(path) { requests.push(path); return Promise.resolve({ show: true }); },
    dismissedFinishedMatchId: null, finishedMatchEventId: null,
  };
  const paint = runInNewContext(adapter.slice(begin, end) + "\npaintPlayerMatch", context);
  const finished = {
    id: "match-1", matchNo: "第一场", state: "finished", elapsedMs: 300000,
    blue: { name: "蓝队", score: 10 }, red: { name: "红队", score: 2 },
  };
  const next = {
    id: "match-2", matchNo: "第二场", state: "ready", elapsedMs: 0,
    blue: { name: "蓝队", score: 0 }, red: { name: "红队", score: 0 },
  };
  paint({ match: next, lastFinishedMatch: finished, elapsedMs: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements("[data-live-blue-score]")[0].textContent, "0");
  assert.equal(elements("[data-live-red-score]")[0].textContent, "0");
  assert.equal(elements("[data-live-match-clock]")[0].textContent, "00:00");
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/api/competition/match/finish-notice");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.matchId, "match-1");
  assert.equal(events[0].detail.blueScore, 10);
  context.window.fishCompetitionDismissFinishedNotice("match-1");
  paint({ match: next, lastFinishedMatch: finished, elapsedMs: 0 });
  assert.equal(requests.length, 1);
  assert.equal(elements("[data-live-blue-score]")[0].textContent, "0");
});
