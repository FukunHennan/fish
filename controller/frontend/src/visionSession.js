export function canEditVision(session) {
  return Boolean(session?.sessionId && session.state === "processing");
}

export function visionStreamUrl(sessionId, retry = 0) {
  return `/api/vision/sessions/${encodeURIComponent(sessionId)}/stream.mjpg?retry=${retry}`;
}

export async function visionRequest(path, options = {}) {
  const response = await fetch(`/api/vision${path}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) {
    throw new Error(result.error?.message || result.message || "视觉操作失败");
  }
  return result;
}
