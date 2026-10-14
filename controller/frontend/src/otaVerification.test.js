import test from "node:test";
import assert from "node:assert/strict";
import { verifyOta } from "./otaVerification.js";

test("OTA 必须重启且匹配构建指纹和版本才成功", async () => {
  let time = 0;
  let index = 0;
  const samples = [
    { online: true, bootId: "before", firmwareBuildId: "new", firmwareVersion: "v2" },
    { online: true, bootId: "after", firmwareBuildId: "old", firmwareVersion: "v2" },
    { online: true, bootId: "after", firmwareBuildId: "new", firmwareVersion: "v2" },
  ];
  const device = await verifyOta({ deviceId: "fish", previousBootId: "before", expectedBuildId: "new", expectedVersion: "v2", now: () => time, sleep: async () => { time += 2000; }, readDevices: async () => [{ deviceId: "fish", ...samples[index++] }] });
  assert.equal(index, 3);
  assert.equal(device.bootId, "after");
});

test("缺少构建指纹或超时不能报告升级成功", async () => {
  await assert.rejects(verifyOta({}), /缺少构建标识/);
  await assert.rejects(verifyOta({ expectedBuildId: "new", timeoutMs: 0 }), /结果未确认/);
});
