import assert from "node:assert/strict";
import test from "node:test";

import { clamp, motionCenter, motionRange } from "./motionCalibration.js";

const profile = {
  servoMin: 20,
  servoMax: 160,
  straightCenter: 90,
  forwardAmplitudePercent: 0.45,
  leftCenterRatio: 0.5,
  leftAmplitudePercent: 0.55,
  rightCenterRatio: 0.5,
  rightAmplitudePercent: 0.55,
};

test("clamp applies bounds and fallback", () => {
  assert.equal(clamp(12, 0, 10, 5), 10);
  assert.equal(clamp(-2, 0, 10, 5), 0);
  assert.equal(clamp("bad", 0, 10, 5), 5);
});

test("forward motion stays centered on straight trim", () => {
  const range = motionRange(profile, "forward");
  assert.equal(range.center, 90);
  assert.equal(range.min, 58.5);
  assert.equal(range.max, 121.5);
});

test("left and right centers mirror around straight trim for symmetric limits", () => {
  assert.equal(motionCenter(profile, "left"), 125);
  assert.equal(motionCenter(profile, "right"), 55);
});

test("turn amplitudes stay inside configured servo limits", () => {
  for (const mode of ["left", "right"]) {
    const range = motionRange(profile, mode);
    assert.ok(range.min >= profile.servoMin);
    assert.ok(range.max <= profile.servoMax);
  }
});

test("asymmetric servo limits are respected", () => {
  const range = motionRange({ ...profile, servoMin: 10, servoMax: 150, straightCenter: 80 }, "forward");
  assert.equal(range.center, 80);
  assert.ok(range.min >= 10);
  assert.ok(range.max <= 150);
});
