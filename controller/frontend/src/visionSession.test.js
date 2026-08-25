import test from "node:test";
import assert from "node:assert/strict";
import { canEditVision, visionStreamUrl } from "./visionSession.js";

test("只有处理状态允许编辑视觉画布", () => {
  assert.equal(canEditVision({ state: "processing", sessionId: "abc" }), true);
  for (const state of ["idle", "opening", "previewing", "tracking", "stopping", "error"]) {
    assert.equal(canEditVision({ state, sessionId: "abc" }), false);
  }
});

test("视频地址绑定视觉会话避免复用旧流", () => {
  assert.equal(
    visionStreamUrl("session A", 2),
    "/api/vision/sessions/session%20A/stream.mjpg?retry=2",
  );
});
