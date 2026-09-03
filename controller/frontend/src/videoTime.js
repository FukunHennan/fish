export function formatVideoClock(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatServerClock(
  serverTime,
  serverUtcOffsetMinutes = 0,
  receivedAt = Date.now(),
  now = Date.now(),
) {
  const epochMs = Number(serverTime) * 1000;
  if (!Number.isFinite(epochMs)) return "—";
  const elapsed = Math.max(0, Number(now) - Number(receivedAt));
  const offsetMinutes = Number(serverUtcOffsetMinutes);
  const offsetMs = Number.isFinite(offsetMinutes) ? offsetMinutes * 60 * 1000 : 0;
  const serverWallClock = new Date(
    epochMs + offsetMs + (Number.isFinite(elapsed) ? elapsed : 0),
  );
  return serverWallClock.toISOString().slice(11, 19);
}

export function formatFrameLatency(metrics) {
  const latency = Number(metrics?.frameLatencyMs);
  if (!Number.isFinite(latency)) return "";
  if (latency < 1000) return ` · 处理 ${Math.round(latency)} ms`;
  return ` · 处理 ${(latency / 1000).toFixed(1)} s`;
}
