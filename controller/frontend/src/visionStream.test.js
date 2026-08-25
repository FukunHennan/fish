import test from "node:test";
import assert from "node:assert/strict";

import { visionStreamSource } from "./visionStream.js";

test("视频流重连时生成不同地址，强制浏览器重新发起请求", () => {
  assert.equal(visionStreamSource(0), "/api/vision/stream.mjpg?retry=0");
  assert.equal(visionStreamSource(1), "/api/vision/stream.mjpg?retry=1");
});
