import assert from "node:assert/strict";
import test from "node:test";

import { trackingStartBlockers } from "./trackingAvailability.js";

test("循迹未就绪时合并并去重前后端阻塞原因", () => {
  assert.deepEqual(trackingStartBlockers({
    running: true,
    workflow: {
      canStart: false,
      blockers: ["检测到多条鱼，请锁定单一目标", "尚未绘制有效轨迹"],
    },
    effectiveTargetDeviceId: "fish-1",
    singleFishMode: false,
    detectionCount: 2,
    selectedTrackId: null,
    processing: true,
  }), ["检测到多条鱼，请锁定单一目标", "尚未绘制有效轨迹"]);
});

test("没有选择设备时给出前端阻塞原因", () => {
  assert.deepEqual(trackingStartBlockers({
    running: true,
    workflow: { canStart: true, blockers: [] },
  }), ["请先选择要控制的机器鱼"]);
});

test("视觉服务未启动时只提示先启动服务", () => {
  assert.deepEqual(trackingStartBlockers({
    running: false,
    workflow: { canStart: false, blockers: ["视觉识别未启动"] },
  }), ["视觉服务未启动"]);
});

test("循迹运行中时按钮提示无需重复启动", () => {
  assert.deepEqual(trackingStartBlockers({
    running: true,
    workflow: { canStart: true, trackingActive: true, blockers: [] },
    effectiveTargetDeviceId: "fish-1",
    singleFishMode: true,
  }), ["循迹已经在运行"]);
});
