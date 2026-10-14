export async function verifyOta({ deviceId, previousBootId, expectedBuildId, expectedVersion, readDevices, timeoutMs = 120000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!expectedBuildId) throw new Error("固件缺少构建标识，无法确认升级成功");
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(2000);
    let devices;
    try { devices = await readDevices(); } catch { continue; }
    const device = devices.find((item) => item.deviceId === deviceId);
    if (!device) continue;
    if (device.otaState === "FAILED") throw new Error("设备报告 OTA 失败");
    if (device.online && device.bootId && device.bootId !== previousBootId && device.firmwareBuildId === expectedBuildId && device.firmwareVersion === expectedVersion) return device;
  }
  throw new Error("升级结果未确认：未检测到重启后运行目标固件，请勿视为成功");
}
