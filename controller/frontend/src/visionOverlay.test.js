import test from "node:test";
import assert from "node:assert/strict";
import { fitVideoRect, toSourcePoint } from "./visionOverlay.js";

test("坐标换算忽略视频上下黑边", () => {
  const content = fitVideoRect({ width: 800, height: 600 }, { width: 640, height: 360 });
  assert.deepEqual(content, { left: 0, top: 75, width: 800, height: 450 });
  assert.deepEqual(
    toSourcePoint({ x: 400, y: 300 }, content, { width: 640, height: 360 }),
    { x: 320, y: 180 },
  );
});

test("源坐标裁剪到视频边界", () => {
  const rect = { left: 10, top: 20, width: 640, height: 480 };
  assert.deepEqual(
    toSourcePoint({ x: -20, y: 900 }, rect, { width: 640, height: 480 }),
    { x: 0, y: 479 },
  );
});
