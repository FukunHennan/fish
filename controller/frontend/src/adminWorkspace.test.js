import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("管理员只呈现设备检查和高级设置，不挂载视频组件", () => {
  const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /import VisionPanel|<VisionPanel|>视觉控制<|>设备维护</);
  assert.match(source, />高级设置</);
  assert.match(source, /<DeviceRail[\s\S]*?selectedId=\{selectedDeviceId\}[\s\S]*?onSelect=\{\(device\) => setSelectedDeviceId\(device.deviceId\)\}/);
  assert.match(source, /<ManualInspector/);
  assert.match(source, /<SettingsWorkspace/);
});
