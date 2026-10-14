import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/competition/replay-transport.js", import.meta.url), "utf8");

function harness(response) {
  const calls = [];
  const timers = [];
  const link = { click() { calls.push("click"); }, remove() { calls.push("remove"); } };
  const context = {
    window: {}, AbortController,
    fetch: async (url, options) => { calls.push({ url, options }); return response; },
    document: { createElement: () => link, body: { appendChild() {} } },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: (url) => calls.push(url) },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout: (timer) => calls.push({ cleared: timer }),
  };
  runInNewContext(source, context);
  return { download: context.window.FishReplayTransport.download, calls, timers, link };
}

test("下载使用认证 HTTP 文件接口并清理临时链接", async () => {
  const state = harness({ ok: true, headers: { get: () => "video/mp4" }, blob: async () => ({ size: 100 }) });
  await state.download("/api/vision/recordings/files/%E6%AF%94%E8%B5%9B.mp4");
  assert.equal(state.calls[0].options.credentials, "same-origin");
  assert.equal(state.link.download, "比赛.mp4");
  assert.ok(state.calls.includes("click"));
  assert.ok(state.calls.includes("remove"));
  state.timers[1]();
  assert.ok(state.calls.includes("blob:test"));
});

test("下载拒绝无效路径，不发送网络请求", async () => {
  const state = harness({});
  await assert.rejects(state.download("https://example.com/video.mp4"), /录像地址无效/);
  await assert.rejects(state.download("/api/vision/recordings/files/..%2Fvideo.mp4"), /录像文件名无效/);
  assert.equal(state.calls.length, 0);
});

test("下载显示服务错误并拒绝 HTML 登录页面和空录像", async () => {
  const denied = harness({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(denied.download("/api/vision/recordings/files/test.mp4"), /重新登录/);
  const html = harness({ ok: true, headers: { get: () => "text/html" } });
  await assert.rejects(html.download("/api/vision/recordings/files/test.mp4"), /未返回录像/);
  const empty = harness({ ok: true, headers: { get: () => "video/mp4" }, blob: async () => ({ size: 0 }) });
  await assert.rejects(empty.download("/api/vision/recordings/files/test.mp4"), /文件为空/);
});
