import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/competition/referee_interface.html", import.meta.url), "utf8");
const start = html.indexOf("window.applyCompetitionRecords=function(records){");
const end = html.indexOf("\nsearch.oninput=renderHistory;", start);

test("比赛归档映射保留计分事件、录像时间和事件分类", () => {
  assert.ok(start >= 0 && end > start);
  const history = [];
  const context = {
    window: {}, history, historySelected: null,
    fmt(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; },
    renderHistory() {}, renderHistoryDetail() {},
  };
  runInNewContext(html.slice(start, end), context);
  context.window.applyCompetitionRecords([{
    id: "match-1", matchNo: "第一场", blueScore: 8, redScore: 0,
    bluePlayers: ["甲", "乙"], videoDurationMs: 45000, durationMs: 240000,
    scoreEvents: [
      { side: "blue", kind: "goal", label: "进球", delta: 10, remainingMs: 235000, videoTimestampSeconds: 5.2 },
      { side: "blue", kind: "out", label: "越界", delta: -2, remainingMs: 220000, videoTimestampSeconds: 20.1 },
      { side: "red", kind: "out", label: "越界", delta: 0, remainingMs: 210000 },
    ],
  }]);
  assert.equal(history.length, 1);
  assert.equal(history[0].blue.g, 1);
  assert.equal(history[0].blue.o, 1);
  assert.equal(history[0].red.o, 1);
  assert.equal(history[0].blue.players, "甲、乙");
  assert.equal(history[0].matchDurationMs, 240000);
  assert.equal(history[0].events[0].matchTime, "03:55");
  assert.equal(history[0].events[0].videoTime, 5.2);
  assert.equal(history[0].events[2].videoTime, null);
});

test("旧比赛复用同一 ID 时历史列表仍能分别选择", () => {
  const history = [];
  const context = {
    window: {}, history, historySelected: null,
    fmt() { return "00:00"; }, renderHistory() {}, renderHistoryDetail() {},
  };
  runInNewContext(html.slice(start, end), context);
  context.window.applyCompetitionRecords([
    { id: "same-match", finishedAt: "2026-10-10T09:54:06+08:00" },
    { id: "same-match", finishedAt: "2026-10-09T19:25:38+08:00" },
  ]);
  assert.equal(history.length, 2);
  assert.notEqual(history[0].id, history[1].id);
});
