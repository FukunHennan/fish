import test from "node:test";
import assert from "node:assert/strict";

import { chooseCameraIndex, toVideoPoint } from "./coordinates.js";

test("converts displayed pointer coordinates to original video pixels", () => {
  assert.deepEqual(
    toVideoPoint({ clientX: 260, clientY: 170 }, { left: 100, top: 50, width: 320, height: 240 }, 640, 480),
    { x: 320, y: 240 },
  );
});

test("clips pointer coordinates to the video boundary", () => {
  assert.deepEqual(
    toVideoPoint({ clientX: 999, clientY: -20 }, { left: 100, top: 50, width: 320, height: 240 }, 640, 480),
    { x: 639, y: 0 },
  );
});

test("running vision state selects the camera used by the backend", () => {
  const cameras = [{ index: 0 }, { index: 1 }];
  assert.equal(chooseCameraIndex("0", cameras, { state: "running", cameraIndex: 1 }), "1");
  assert.equal(chooseCameraIndex("", cameras, { state: "stopped", cameraIndex: null }), "0");
});
