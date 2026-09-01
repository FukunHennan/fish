export function formatVideoClock(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatFrameLatency(metrics) {
  const latency = Number(metrics?.frameLatencyMs);
  if (!Number.isFinite(latency)) return "";
  if (latency < 1000) return ` · 延时 ${Math.round(latency)} ms`;
  return ` · 延时 ${(latency / 1000).toFixed(1)} s`;
}
