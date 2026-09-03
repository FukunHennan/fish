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
  assert.equal(range.min, 74.25);
  assert.equal(range.max, 105.75);
});

test("left and right centers mirror around straight trim for symmetric limits", () => {
  assert.equal(motionCenter(profile, "left"), 55);
  assert.equal(motionCenter(profile, "right"), 125);
});

test("left and right centers use half of the smaller available offset", () => {
  const asymmetricCenter = {
    ...profile,
    servoMin: 0,
    servoMax: 180,
    straightCenter: 100,
  };
  assert.equal(motionCenter(asymmetricCenter, "left"), 60);
  assert.equal(motionCenter(asymmetricCenter, "right"), 140);
});

test("turn amplitudes stay inside configured servo limits", () => {
  for (const mode of ["left", "right"]) {
    const range = motionRange(profile, mode);
    assert.ok(range.min >= profile.servoMin);
    assert.ok(range.max <= profile.servoMax);
  }
});

test("full calibrated ranges use the smaller available side", () => {
  const fullProfile = {
    ...profile,
    servoMin: 0,
    servoMax: 180,
    straightCenter: 90,
    forwardAmplitudePercent: 1,
    leftAmplitudePercent: 1,
    rightAmplitudePercent: 1,
  };

  assert.deepEqual(motionRange(fullProfile, "forward"), {
    center: 90,
    amplitude: 45,
    min: 45,
    max: 135,
  });
  assert.deepEqual(motionRange(fullProfile, "left"), {
    center: 45,
    amplitude: 45,
    min: 0,
    max: 90,
  });
  assert.deepEqual(motionRange(fullProfile, "right"), {
    center: 135,
    amplitude: 45,
    min: 90,
    max: 180,
  });
});

test("asymmetric servo limits are respected", () => {
  const range = motionRange({ ...profile, servoMin: 10, servoMax: 150, straightCenter: 80 }, "forward");
  assert.equal(range.center, 80);
  assert.ok(range.min >= 10);
  assert.ok(range.max <= 150);
});

test("asymmetric straight center keeps left and right turn amplitudes equal", () => {
  const asymmetricCenter = {
    ...profile,
    servoMin: 0,
    servoMax: 180,
    straightCenter: 100,
    leftAmplitudePercent: 1,
    rightAmplitudePercent: 1,
  };
  assert.equal(motionRange(asymmetricCenter, "left").amplitude, 40);
  assert.equal(motionRange(asymmetricCenter, "right").amplitude, 40);
});
