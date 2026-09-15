const JSON_HEADERS = { "Content-Type": "application/json" };

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      ...JSON_HEADERS,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.message || (typeof payload === "string" && payload) || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function jsonRequest(path, method, body) {
  return request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const competitionApi = {
  authMe: () => request("/api/auth/me"),
  login: (email, password) => jsonRequest("/api/auth/login", "POST", { email, password }),
  logout: () => jsonRequest("/api/auth/logout", "POST"),
  getMatch: () => request("/api/competition/match"),
  getRecords: () => request("/api/competition/records"),
  getDevices: () => request("/api/competition/devices"),
  updateMatch: (body) => jsonRequest("/api/competition/match", "PUT", body),
  action: (name, body) => jsonRequest(`/api/competition/match/${name}`, "POST", body),
};

export function formatCompetitionClock(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function competitionStateLabel(state) {
  return {
    waiting: "等待开始",
    signup: "签到中",
    ready: "准备就绪",
    running: "进行中",
    paused: "已暂停",
    finished: "已结束",
  }[state] || state || "暂无比赛";
}
