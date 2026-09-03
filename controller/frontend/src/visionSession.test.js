import test from "node:test";
import assert from "node:assert/strict";
import {
  canEditVision,
  visionStreamUrl,
  visionWebRTCConfigUrl,
  visionWebRTCOfferUrl,
} from "./visionSession.js";

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

test("WebRTC 使用独立的配置和信令接口", () => {
  assert.equal(visionWebRTCConfigUrl(), "/api/vision/webrtc/config");
  assert.equal(visionWebRTCOfferUrl(), "/api/vision/webrtc/offer");
});
