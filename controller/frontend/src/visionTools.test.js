import test from "node:test";
import assert from "node:assert/strict";
import { transitionVisionTool } from "./visionTools.js";

test("关闭选择工具时向后端发送对应的退出切换事件", () => {
  assert.deepEqual(transitionVisionTool("calibration", "calibration"), {
    activeTool: "",
    actionType: "calibration.toggle",
  });
  assert.deepEqual(transitionVisionTool("marker", "marker"), {
    activeTool: "",
    actionType: "marker.select",
  });
  assert.deepEqual(transitionVisionTool("heading", "heading"), {
    activeTool: "",
    actionType: "heading.select",
  });
});

test("关闭轨迹绘制只清除网页工具状态", () => {
  assert.deepEqual(transitionVisionTool("path", "path"), {
    activeTool: "",
    actionType: "",
  });
});
