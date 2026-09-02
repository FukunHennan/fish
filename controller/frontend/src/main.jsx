import { Component, StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./maintenance.css";
import "./rename.css";
import VisionPanel from "./VisionPanel.jsx";
import VideoStream from "./VideoStream.jsx";
import { chooseCameraIndex } from "./coordinates.js";
import { visionEventUrl, visionRequest } from "./visionSession.js";
import { formatFrameLatency, formatServerClock, formatVideoClock } from "./videoTime.js";
import { motionRange } from "./motionCalibration.js";

const MODE_LABELS = {
  stop: "停止", idle: "待机", forward: "前进", left: "左转", right: "右转",
  0: "停止", 1: "待机", 2: "前进", 3: "左转", 4: "右转",
};
const ALIAS_STORAGE_KEY = "fish-controller-device-aliases-v1";
const CALIBRATION_STORAGE_KEY = "fish-controller-motion-calibration-v1";
const DEFAULT_AMPLITUDE_PERCENT = 40;
const KEYBOARD_TICK_MS = 50;
const KEYBOARD_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space"]);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
function deviceLabel(device) { return device.name || device.deviceId || "未命名机器鱼"; }
function formatBytes(bytes = 0) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
function loadAliases() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ALIAS_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}
function loadCalibrationProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CALIBRATION_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}
function normalizeDeviceName(value) { return String(value || "").trim().toLocaleLowerCase(); }
function batteryLevel(device) {
  const value = Number(device?.batteryPercent);
  return Number.isFinite(value) && Number(device?.batteryVoltage) > 0 ? value : null;
}
function batteryTone(percent) { return percent == null ? "unknown" : percent < 20 ? "critical" : percent < 40 ? "low" : "normal"; }
function amplitudePercentFromDevice(device) {
  const amplitude = Number(device?.amplitude);
  if (!Number.isFinite(amplitude)) return DEFAULT_AMPLITUDE_PERCENT;
  return clamp((amplitude / 90) * 100, 0, 100, DEFAULT_AMPLITUDE_PERCENT);
}
function keyboardMode(pressed) {
  if (pressed.has("KeyS") || pressed.has("Space")) return "stop";
  if (pressed.has("KeyA") && pressed.has("KeyD")) return "stop";
  if (pressed.has("KeyA")) return "left";
  if (pressed.has("KeyD")) return "right";
  if (pressed.has("KeyW")) return "forward";
  return "stop";
}
function isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
}
function sameStringSet(first, second) {
  if (first.size !== second.size) return false;
  for (const value of first) {
    if (!second.has(value)) return false;
  }
  return true;
}
function cameraLabel(camera) {
  const model = camera.model || camera.name || `摄像头 ${camera.index}`;
  const size = camera.width && camera.height ? `${camera.width}×${camera.height}` : "";
  const fps = camera.fps ? `${camera.fps}FPS` : "";
  return [`#${camera.index}`, model, [size, fps].filter(Boolean).join(" @ ")].filter(Boolean).join(" · ");
}

function deviceStateSignature(devices) {
  return JSON.stringify(
    devices
      .map(({ lastSeen, uptimeMs, batterySampleAgeMs, ...stable }) => stable)
      .sort((first, second) => String(first.deviceId).localeCompare(String(second.deviceId))),
  );
}

function sessionErrorMessage(status) {
  const error = status?.error;
  if (!error) return "";
  return typeof error === "string" ? error : error.message || error.code || "";
}

const DEFAULT_OVERLAYS = { detections: false, paths: false };

function overlayState(status, fallback) {
  return { ...DEFAULT_OVERLAYS, ...(fallback || {}), ...(status.metrics?.overlays || {}) };
}

function ManualVideoPreview() {
  const [cameras, setCameras] = useState([]);
  const [cameraIndex, setCameraIndex] = useState("");
  const [status, setStatus] = useState({ state: "idle", error: "" });
  const [feedback, setFeedback] = useState("可以不选择鱼，先打开摄像头作为手动驾驶视角。");
  const [streamFeedback, setStreamFeedback] = useState("");
  const [streamRetry, setStreamRetry] = useState(0);
  const [streamState, setStreamState] = useState("idle");
  const [videoBusy, setVideoBusy] = useState(false);
  const [switchingCamera, setSwitchingCamera] = useState(false);
  const [overlayPrefs, setOverlayPrefs] = useState(DEFAULT_OVERLAYS);
  const [clock, setClock] = useState(() => formatVideoClock());
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [serverTime, setServerTime] = useState(null);
  const [serverUtcOffsetMinutes, setServerUtcOffsetMinutes] = useState(0);
  const [serverTimeReceivedAt, setServerTimeReceivedAt] = useState(0);
  const streamRetryTimerRef = useRef(null);
  const camerasRef = useRef([]);

  const running = ["previewing", "processing", "tracking"].includes(status.state);
  const processing = ["processing", "tracking"].includes(status.state);
  const tracking = status.state === "tracking";
  const selectedCamera = cameras.find((camera) => camera.index === Number(cameraIndex));
  const videoWidth = status.metrics?.frame?.width || selectedCamera?.width || 640;
  const videoHeight = status.metrics?.frame?.height || selectedCamera?.height || 480;
  const yolo = status.metrics?.yolo;
  const yoloLabel = yolo?.ready ? "识别中" : yolo?.loading ? "模型加载中" : yolo?.error ? "识别异常" : "仅监看";
  const overlays = overlayState(status, overlayPrefs);
  const latencyLabel = formatFrameLatency(status.metrics);
  const serverClock = formatServerClock(
    serverTime,
    serverUtcOffsetMinutes,
    serverTimeReceivedAt,
    clockTick,
  );

  function captureServerTime(payload) {
    const value = Number(payload?.serverTime ?? payload?.data?.serverTime);
    if (!Number.isFinite(value)) return;
    setServerTime(value);
    const offset = Number(payload?.serverUtcOffsetMinutes ?? payload?.data?.serverUtcOffsetMinutes);
    if (Number.isFinite(offset)) setServerUtcOffsetMinutes(offset);
    setServerTimeReceivedAt(Date.now());
  }

  useEffect(() => {
    const tick = () => {
      setClock(formatVideoClock());
      setClockTick(Date.now());
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [cameraResponse, statusResponse] = await Promise.all([
          fetch("/api/vision/cameras", { cache: "no-store" }),
          fetch("/api/vision/sessions/current", { cache: "no-store" }),
        ]);
        if (!cameraResponse.ok || !statusResponse.ok) throw new Error("摄像头服务未就绪");
        const cameraList = await cameraResponse.json();
        const statusEnvelope = await statusResponse.json();
        const nextStatus = statusEnvelope.data || statusEnvelope;
        if (!active) return;
        camerasRef.current = cameraList;
        captureServerTime(statusEnvelope);
        setCameras(cameraList);
        setStatus(nextStatus);
        setCameraIndex((current) => chooseCameraIndex(current, cameraList, nextStatus));
      } catch (error) {
        if (active) setFeedback(error.message);
      }
    }
    refresh();
    if (typeof window.EventSource !== "function") {
      if (active) setFeedback("当前浏览器不支持视觉状态推送");
      return () => { active = false; };
    }
    const source = new window.EventSource(visionEventUrl());
    source.addEventListener("session", (event) => {
      if (!active) return;
      try {
        const envelope = JSON.parse(event.data);
        const nextStatus = envelope.data || envelope;
        captureServerTime(envelope);
        setStatus(nextStatus);
        setCameraIndex((current) => chooseCameraIndex(current, camerasRef.current, nextStatus));
      } catch {
        setFeedback("视觉状态数据无效");
      }
    });
    return () => {
      active = false;
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!running) {
      if (streamRetryTimerRef.current) window.clearTimeout(streamRetryTimerRef.current);
      streamRetryTimerRef.current = null;
      setStreamFeedback("");
      setStreamRetry(0);
      setStreamState("idle");
    } else {
      setStreamState("loading");
    }
  }, [running]);

  useEffect(() => () => {
    if (streamRetryTimerRef.current) window.clearTimeout(streamRetryTimerRef.current);
  }, []);

  function updateStreamRetry() {
    if (streamRetryTimerRef.current) window.clearTimeout(streamRetryTimerRef.current);
    streamRetryTimerRef.current = window.setTimeout(() => {
      setStreamRetry((current) => current + 1);
      streamRetryTimerRef.current = null;
    }, 1200);
  }

  function handleStreamError() {
    setStreamState("error");
    setStreamFeedback("视频流中断，正在自动重连…");
    updateStreamRetry();
  }

  function handleStreamReady() {
    setStreamState("ready");
    if (streamRetryTimerRef.current) window.clearTimeout(streamRetryTimerRef.current);
    streamRetryTimerRef.current = null;
    setStreamFeedback("");
    setFeedback(processing ? "识别画面已连接。" : "预览画面已连接。");
  }

  async function adoptCurrentSession() {
    const current = await visionRequest("/sessions/current");
    const nextStatus = current.data || current;
    if (nextStatus?.sessionId && ["previewing", "processing", "tracking"].includes(nextStatus.state)) {
      setStatus(nextStatus);
      setCameraIndex((currentIndex) => chooseCameraIndex(currentIndex, cameras, nextStatus));
      setStreamRetry((currentRetry) => currentRetry + 1);
      return nextStatus;
    }
    return null;
  }

  async function startPreview() {
    if (videoBusy) return;
    if (running && status.sessionId) {
      setFeedback("已接入当前视频画面；可以直接边看边手动控制。");
      return;
    }
    setVideoBusy(true);
    setStreamFeedback("");
    try {
      if (cameraIndex === "") throw new Error("请选择摄像头");
      setFeedback("正在打开摄像头…");
      const result = await visionRequest("/sessions", {
        method: "POST",
        body: JSON.stringify({ cameraId: `camera-${cameraIndex}`, cameraIndex: Number(cameraIndex) }),
      });
      setStatus(result.data);
      captureServerTime(result);
      setStreamRetry((currentRetry) => currentRetry + 1);
      setFeedback("手动监看已开启；现在可以边看画面边控制机器鱼。");
    } catch (error) {
      if (/已存在|session_exists/.test(error.message || "")) {
        try {
          const existing = await adoptCurrentSession();
          if (existing) {
            setFeedback("已接入现有摄像头画面；如需切换摄像头，请先关闭视频。");
            return;
          }
        } catch {
          // Fall through to the original error below.
        }
      }
      setFeedback(error.message);
    } finally {
      setVideoBusy(false);
    }
  }

  async function stopPreview() {
    if (videoBusy) return;
    setVideoBusy(true);
    try {
      if (!status.sessionId) return;
      const result = await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}`, { method: "DELETE" });
      setStatus(result.data);
      setStreamFeedback("");
      setFeedback("摄像头监看已关闭。");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setVideoBusy(false);
    }
  }

  async function changeCamera(event) {
    const nextCameraIndex = event.target.value;
    if (!running) {
      setCameraIndex(nextCameraIndex);
      return;
    }
    if (Number(nextCameraIndex) === status.cameraIndex || switchingCamera) return;
    const previousCameraIndex = String(status.cameraIndex);
    setCameraIndex(nextCameraIndex);
    setSwitchingCamera(true);
    setStreamState("loading");
    setStreamFeedback("正在切换摄像头…");
    try {
      const result = await visionRequest(
        `/sessions/${encodeURIComponent(status.sessionId)}/camera`,
        {
          method: "POST",
          body: JSON.stringify({
            cameraId: `camera-${nextCameraIndex}`,
            cameraIndex: Number(nextCameraIndex),
          }),
        },
      );
      setStatus(result.data);
      captureServerTime(result);
      setStreamRetry((current) => current + 1);
      setFeedback("摄像头已切换，视频保持开启。");
    } catch (error) {
      setCameraIndex(previousCameraIndex);
      setFeedback(error.message);
    } finally {
      setSwitchingCamera(false);
    }
  }

  async function toggleProcessing() {
    if (videoBusy) return;
    setVideoBusy(true);
    try {
      if (!status.sessionId) return;
      const result = await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}/processing`, { method: processing ? "DELETE" : "POST" });
      setStatus(result.data);
      setFeedback(processing ? "已回到单纯视频预览。" : "已开启识别叠加；手动控制仍由你接管。");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setVideoBusy(false);
    }
  }

  async function setOverlay(key, enabled) {
    const next = { ...overlays, [key]: enabled };
    setOverlayPrefs(next);
    try {
      if (!status.sessionId || !running) return;
      await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "overlay.set", overlays: next }),
      });
      setStatus((current) => ({ ...current, metrics: { ...(current.metrics || {}), overlays: next } }));
      setFeedback(`${key === "detections" ? "识别框" : "路径线"}已${enabled ? "显示" : "屏蔽"}`);
    } catch (error) {
      setFeedback(error.message);
    }
  }

  return (
    <section className="manual-video-card panel-surface" aria-label="手动视频监看">
      <div className="panel-heading">
        <div><span className="eyebrow">DRIVER VIEW</span><h2>视频监看</h2><small>手动控制时观察摄像头画面</small></div>
        <span className={`status ${running ? "online" : "offline"}`}><i />{running ? yoloLabel : "未开启"}</span>
      </div>
      <div className="manual-video-stage" style={{ "--video-aspect": `${videoWidth} / ${videoHeight}` }}>
        {running ? <>
          <VideoStream
            sessionId={status.sessionId}
            retry={streamRetry}
            onError={handleStreamError}
            onReady={handleStreamReady}
            onTransportError={(error) => setStreamFeedback(`${error?.message || "WebRTC 暂不可用"}，正在重连。`)}
            alt="手动控制摄像头画面"
          />
          {streamState !== "ready" && <div className={`video-stream-status ${streamState}`}>
            <strong>{streamState === "error" ? "视频流暂时不可用" : "正在连接视频流…"}</strong>
            <span>{streamState === "error" ? (sessionErrorMessage(status) || "摄像头未返回可显示画面，正在自动重试") : "请稍候，摄像头画面即将出现"}</span>
          </div>}
        </> : <div className={`video-placeholder ${status.state === "error" ? "has-error" : ""}`}><strong>{status.state === "error" ? "摄像头启动失败" : "驾驶视角未开启"}</strong><span>{sessionErrorMessage(status) || "选择摄像头后开始监看"}</span></div>}
        {running && <div className="video-badge">服务器 {serverClock}<br />本机 {clock}{latencyLabel}<br />{videoWidth} × {videoHeight}</div>}
      </div>
      <div className="manual-video-controls">
        <label className="camera-select">摄像头<select value={cameraIndex} disabled={switchingCamera} onChange={changeCamera}><option value="">请选择摄像头</option>{cameras.map((camera) => <option key={camera.index} value={camera.index}>{cameraLabel(camera)}</option>)}</select></label>
        <div className="manual-video-actions">
          <button disabled={videoBusy || running || cameraIndex === "" || switchingCamera} onClick={startPreview}>{videoBusy ? "打开中…" : running ? "视频已开启" : "开启监看"}</button>
          <button disabled={videoBusy || !running || tracking || switchingCamera} onClick={toggleProcessing}>{tracking ? "循迹中" : processing ? "关闭识别" : "叠加识别"}</button>
          <button className="stop" disabled={videoBusy || !running || tracking || switchingCamera} onClick={stopPreview}>关闭</button>
        </div>
      </div>
      <div className="overlay-toggle-row" aria-label="手动视频画面显示选项">
        <label><input type="checkbox" checked={overlays.detections} disabled={!running} onChange={(event) => setOverlay("detections", event.target.checked)} /> 显示 YOLO 识别</label>
        <label><input type="checkbox" checked={overlays.paths} disabled={!running} onChange={(event) => setOverlay("paths", event.target.checked)} /> 显示路径</label>
      </div>
      <p className="feedback" aria-live="polite">{streamFeedback || feedback}</p>
    </section>
  );
}

function AuthScreen({ onAuthenticated, bootstrap }) {
  const [mode, setMode] = useState(bootstrap ? "bootstrap" : "login");
  const [name, setName] = useState("陈富坤");
  const [email, setEmail] = useState("chenfukun@example.com");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [feedback, setFeedback] = useState("当前：电脑/平板/手机会自动适配；请使用本地账号登录。");
  const [busy, setBusy] = useState(false);

  async function submitAuth(event) {
    event.preventDefault();
    if (busy) return;
    if (mode === "bootstrap" && password !== confirmPassword) {
      setFeedback("两次密码不一致");
      return;
    }
    setBusy(true);
    setFeedback(mode === "login" ? "正在登录…" : "正在创建管理员账户…");
    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { email, password } : { name, email, password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.authenticated === false) {
        throw new Error(result.message || (mode === "login" ? "登录失败" : "管理员账户创建失败"));
      }
      onAuthenticated(result.user);
    } catch (authError) {
      setFeedback(authError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page" data-mode={mode}>
      <div className="auth-frame">
        <div className="auth-browser-bar" aria-hidden="true">
          <span className="auth-lamp" />
          <span className="auth-lamp" />
          <span className="auth-lamp" />
          <span className="auth-url">fish.chenfukun.space/login</span>
        </div>

        <div className="auth-screen">
          <section className="auth-side">
            <div className="auth-brand">
              <div className="auth-logo">鱼</div>
              <div><small>FISH CONTROL</small><strong>多鱼控制平台</strong></div>
            </div>

            <div className="auth-copy-main">
              <h1>安全进入控制台</h1>
              <p>登录只保留必要信息。通过身份校验后，才显示手动、视觉、设置界面，并记录每条鱼的控制者。</p>
            </div>

            <div className="auth-side-bottom">
              <div className="auth-mini-pond" aria-label="Fish status preview">
                <div className="auth-fish-dot">鱼 A</div>
                <div className="auth-fish-dot">鱼 B</div>
                <div className="auth-fish-dot">鱼 C</div>
              </div>
              <div className="auth-pills">
                <span><i />Cloudflare</span>
                <span>多条鱼在线</span>
                <span>控制互斥</span>
              </div>
            </div>
          </section>

          <section className="auth-card" aria-label={bootstrap ? "登录或初始化管理员" : "登录"}>
            {bootstrap && <div className="auth-tabs" role="tablist" aria-label="Login or administrator bootstrap">
              <button className={mode === "login" ? "active" : ""} aria-selected={mode === "login"} type="button" onClick={() => setMode("login")}>登录</button>
              <button className={mode === "bootstrap" ? "active" : ""} aria-selected={mode === "bootstrap"} type="button" onClick={() => setMode("bootstrap")}>初始化管理员</button>
            </div>}

            <div className="auth-form-head">
              <h2>{mode === "login" ? "登录账号" : "创建管理员账户"}</h2>
              <p>{mode === "login" ? (bootstrap ? "系统尚未初始化；也可以先创建首个管理员账户。" : "账户由管理员创建和管理，请使用已有账号登录。") : "首次启动时创建唯一的初始管理员；之后所有账户都必须由管理员建立。"}</p>
            </div>

            <form className="auth-form" onSubmit={submitAuth}>
              {mode === "login" && <>
                <button className="auth-primary" type="button" onClick={() => setFeedback("Cloudflare Access 入口已预留；如果要正式启用，我下一步可以接 Cloudflare Zero Trust。")}>使用 Cloudflare Access 登录</button>
                <div className="auth-divider">或使用本地账号</div>
              </>}

              {mode === "bootstrap" ? <div className="auth-two-col">
                <label className="auth-field"><span>姓名</span><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
                <label className="auth-field"><span>邮箱</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
              </div> : <label className="auth-field"><span>邮箱</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>}

              {mode === "bootstrap" ? <div className="auth-two-col">
                <label className="auth-field"><span>设置密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label>
                <label className="auth-field"><span>确认密码</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label>
              </div> : <label className="auth-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>}

              {mode === "login" && <div className="auth-helper-row">
                <label className="auth-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> 保持登录</label>
                <button type="button" onClick={() => setFeedback("当前版本还没有接入找回密码；管理员可以在服务器端重置账号。")}>忘记密码</button>
              </div>}

              <button className={mode === "login" ? "auth-secondary" : "auth-primary"} disabled={busy}>{busy ? "请稍候…" : mode === "login" ? "进入控制台" : "创建管理员并进入"}</button>
              <p className="auth-feedback" aria-live="polite">{feedback}</p>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

function AdminUsers({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "Operator" });
  const [drafts, setDrafts] = useState({});
  const [feedback, setFeedback] = useState("正在读取账户…");
  const [busy, setBusy] = useState(false);

  async function loadUsers() {
    const response = await fetch("/api/auth/users", { cache: "no-store" });
    const result = await response.json().catch(() => []);
    if (!response.ok) throw new Error(result.message || "无法读取账户");
    const next = Array.isArray(result) ? result : [];
    setUsers(next);
    setDrafts(Object.fromEntries(next.map((user) => [user.id, { name: user.name, role: user.role || "Viewer", status: user.status || "active", password: "" }])));
  }

  useEffect(() => {
    loadUsers().then(() => setFeedback("账户由管理员统一管理")).catch((error) => setFeedback(error.message));
  }, []);

  function updateDraft(id, key, value) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  }

  async function createUser(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback("正在创建账户…");
    try {
      const response = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "创建账户失败");
      setForm({ name: "", email: "", password: "", role: "Operator" });
      await loadUsers();
      setFeedback(`已创建 ${result.user?.email || "新账户"}`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveUser(user) {
    const draft = drafts[user.id];
    if (!draft || busy) return;
    setBusy(true);
    setFeedback(`正在保存 ${user.email}…`);
    try {
      const payload = { id: user.id, name: draft.name };
      if (user.id !== currentUser?.id) {
        payload.role = draft.role;
        payload.status = draft.status;
      }
      if (draft.password) payload.password = draft.password;
      const response = await fetch("/api/auth/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "保存账户失败");
      await loadUsers();
      setFeedback(`已保存 ${result.user?.email || user.email}`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(user) {
    if (busy || user.id === currentUser?.id) return;
    if (!window.confirm(`确定删除账户 ${user.email}？该操作不可撤销。`)) return;
    setBusy(true);
    setFeedback(`正在删除 ${user.email}…`);
    try {
      const response = await fetch("/api/auth/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "删除账户失败");
      await loadUsers();
      setFeedback(`已删除 ${user.email}`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="settings-card admin-users-card">
      <div className="admin-users-heading">
        <div><span className="eyebrow">ADMINISTRATION</span><h2>账户管理</h2><small>只有管理员可以创建、修改和删除账户。</small></div>
        <span className="status online"><i />{users.length} 个账户</span>
      </div>
      <form className="admin-create-form" onSubmit={createUser}>
        <label className="setting"><span>姓名</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：张三" required /></label>
        <label className="setting"><span>邮箱</span><input type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} placeholder="name@example.com" required /></label>
        <label className="setting"><span>初始密码</span><input type="password" minLength="8" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder="至少 8 位" required /></label>
        <label className="setting"><span>角色</span><select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}><option value="Viewer">Viewer：只能查看</option><option value="Operator">Operator：可以控制设备</option><option value="Admin">Admin：可以管理账户</option></select></label>
        <button className="action" disabled={busy}>创建账户</button>
      </form>
      <div className="admin-user-list">
        {users.map((user) => {
          const draft = drafts[user.id] || { name: user.name, role: user.role || "Viewer", status: user.status || "active", password: "" };
          const isSelf = user.id === currentUser?.id;
          return <div className="admin-user-row" key={user.id}>
            <div className="admin-user-identity"><strong>{user.email}</strong><small>{user.createdAt ? `创建于 ${formatTime(user.createdAt)}` : "本地账户"}{user.lastLoginAt ? ` · 最近登录 ${formatTime(user.lastLoginAt)}` : ""}</small></div>
            <label className="setting"><span>姓名</span><input value={draft.name} onChange={(event) => updateDraft(user.id, "name", event.target.value)} /></label>
            <label className="setting"><span>角色</span><select value={draft.role} disabled={isSelf || busy} onChange={(event) => updateDraft(user.id, "role", event.target.value)}><option value="Viewer">Viewer</option><option value="Operator">Operator</option><option value="Admin">Admin</option></select></label>
            <label className="setting"><span>状态</span><select value={draft.status} disabled={isSelf || busy} onChange={(event) => updateDraft(user.id, "status", event.target.value)}><option value="active">启用</option><option value="disabled">停用</option></select></label>
            <label className="setting"><span>重置密码</span><input type="password" minLength="8" value={draft.password} disabled={isSelf || busy} placeholder={isSelf ? "当前账户不可操作" : "留空表示不修改"} onChange={(event) => updateDraft(user.id, "password", event.target.value)} /></label>
            <div className="admin-user-actions"><button className="action" type="button" disabled={busy} onClick={() => saveUser(user)}>保存</button><button className="danger" type="button" disabled={busy || isSelf} onClick={() => deleteUser(user)}>删除</button></div>
          </div>;
        })}
        {!users.length && <div className="list-row"><strong>暂无账户</strong><span>创建第一个受管理账户。</span></div>}
      </div>
      <p className="feedback" aria-live="polite">{feedback}</p>
    </article>
  );
}

function App() {
  const [auth, setAuth] = useState({ loading: true, authenticated: false, bootstrap: false, user: null });
  const [page, setPage] = useState("manual");
  const [devices, setDevices] = useState([]);
  const [aliases, setAliases] = useState(loadAliases);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [otaSelectedIds, setOtaSelectedIds] = useState(() => new Set());
  const [feedback, setFeedback] = useState("等待控制指令");
  const [sending, setSending] = useState(false);
  const [leaseBusy, setLeaseBusy] = useState(false);
  const [error, setError] = useState("");
  const [firmwareInfo, setFirmwareInfo] = useState({ available: false });
  const [firmwareFile, setFirmwareFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [otaFeedback, setOtaFeedback] = useState("请选择电脑上的 firmware.bin，并选择升级目标");
  const [renameDevice, setRenameDevice] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [rgbColor, setRgbColor] = useState("#00ff66");
  const [rgbBrightness, setRgbBrightness] = useState(32);
  const [rgbOrder, setRgbOrder] = useState("GRB");
  const [visionDeviceId, setVisionDeviceId] = useState("");
  const [calibrationProfiles, setCalibrationProfiles] = useState(loadCalibrationProfiles);
  const keyboardRef = useRef({
    pressed: new Set(),
    timer: null,
    active: false,
    leasePromise: null,
    lastMode: "",
    lastErrorAt: 0,
  });
  const manualControlRef = useRef(null);
  const devicesRef = useRef([]);
  const deviceSignatureRef = useRef("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        setAuth({ loading: false, authenticated: Boolean(data.authenticated), bootstrap: Boolean(data.bootstrap), user: data.user || null });
      })
      .catch(() => {
        if (active) setAuth({ loading: false, authenticated: false, bootstrap: false, user: null });
      });
    return () => { active = false; };
  }, []);

  const onlineDevices = useMemo(() => devices.filter((device) => device.online), [devices]);
  const lowBatteryCount = useMemo(() => onlineDevices.filter((device) => (batteryLevel(device) ?? 101) < 20).length, [onlineDevices]);
  const selectedDevice = useMemo(() => devices.find((device) => device.deviceId === selectedDeviceId) || null, [devices, selectedDeviceId]);
  const otaSelectedDevices = useMemo(() => devices.filter((device) => otaSelectedIds.has(device.deviceId) && device.online), [devices, otaSelectedIds]);
  manualControlRef.current = {
    page,
    authenticated: auth.authenticated,
    currentUserEmail: auth.user?.email,
    selectedDevice,
  };
  useEffect(() => {
    if (!auth.authenticated) return;
    let active = true;
    if (typeof window.EventSource !== "function") {
      setError("当前浏览器不支持设备事件通道");
      return () => { active = false; };
    }
    const source = new window.EventSource("/api/events");
    source.addEventListener("devices", (event) => {
      if (!active) return;
      let raw;
      try {
        raw = JSON.parse(event.data);
      } catch {
        setError("设备事件数据无效");
        return;
      }
      if (!Array.isArray(raw)) return;
      const next = raw.map((device) => ({ ...device, name: aliases[device.deviceId] || device.name }));
      const previous = devicesRef.current;
      const previousByID = new Map(previous.map((device) => [device.deviceId, device]));
      const nextByID = new Map(next.map((device) => [device.deviceId, device]));
      const lostControl = previous
        .filter((previousDevice) => previousDevice.lease?.ownerEmail === auth.user?.email)
        .filter((previousDevice) => {
          const currentDevice = nextByID.get(previousDevice.deviceId);
          return !currentDevice
            || !currentDevice.online
            || currentDevice.lease?.ownerEmail !== auth.user?.email;
        });
      devicesRef.current = next;
      const nextSignature = deviceStateSignature(next);
      if (nextSignature !== deviceSignatureRef.current) {
        deviceSignatureRef.current = nextSignature;
        setDevices(next);
      }
      setError("");
      const valid = new Set(next.map((device) => device.deviceId));
      setSelectedDeviceId((current) => (valid.has(current) ? current : ""));
      setOtaSelectedIds((current) => {
        const filtered = new Set([...current].filter((id) => valid.has(id) && nextByID.get(id)?.online));
        return sameStringSet(current, filtered) ? current : filtered;
      });
      if (lostControl.length) {
        keyboardRef.current.pressed.clear();
        stopKeyboardControl(lostControl);
        setFeedback(`${lostControl.map(deviceLabel).join("、")} 控制权已失效，正在停止设备`);
      }
    });
    source.onerror = () => {
      if (active) setError("设备事件通道暂时断开，浏览器正在自动重连");
    };
    return () => {
      active = false;
      source.close();
    };
  }, [aliases, auth.authenticated, auth.user?.email]);

  useEffect(() => {
    if (!auth.authenticated) return;
    fetch("/api/motion-calibrations", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取标定参数")))
      .then((profiles) => setCalibrationProfiles(profiles && typeof profiles === "object" ? profiles : {}))
      .catch(() => { /* retain local fallback for older controllers */ });
  }, [auth.authenticated]);

  useEffect(() => {
    if (!auth.authenticated) return;
    let active = true;
    async function loadFirmware() {
      try {
        const response = await fetch("/api/firmware", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (active) setFirmwareInfo(data);
      } catch { /* controller may be an older version */ }
    }
    loadFirmware();
    return () => { active = false; };
  }, [auth.authenticated]);

  function toggleSet(setter, deviceId) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) next.delete(deviceId); else next.add(deviceId);
      return next;
    });
  }
  function selectOtaOnline() { setOtaSelectedIds(new Set(onlineDevices.map((device) => device.deviceId))); }

  function openRename(device) {
    setRenameDevice(device);
    setRenameDraft(deviceLabel(device));
    setRenameError("");
  }
  function closeRename() {
    setRenameDevice(null);
    setRenameDraft("");
    setRenameError("");
  }
  function saveRename() {
    if (!renameDevice) return;
    const nextName = renameDraft.trim();
    if (!nextName) { setRenameError("设备名称不能为空"); return; }
    if (nextName.length > 24) { setRenameError("设备名称最多 24 个字符"); return; }
    const normalized = normalizeDeviceName(nextName);
    const duplicate = devices.some((device) => device.deviceId !== renameDevice.deviceId && normalizeDeviceName(deviceLabel(device)) === normalized);
    if (duplicate) { setRenameError("该名称已被其他设备使用，请换一个名称"); return; }
    const nextAliases = { ...aliases, [renameDevice.deviceId]: nextName };
    localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify(nextAliases));
    setAliases(nextAliases);
    setDevices((current) => current.map((device) => device.deviceId === renameDevice.deviceId ? { ...device, name: nextName } : device));
    setFeedback(`${deviceLabel(renameDevice)} 已重命名为 ${nextName}`);
    closeRename();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuth({ loading: false, authenticated: false, bootstrap: false, user: null });
    setDevices([]);
    setSelectedDeviceId("");
    setOtaSelectedIds(new Set());
  }

  async function acquireLease(device, mode = "manual", force = false) {
    if (!device?.deviceId) throw new Error("设备信息无效，请重新选择设备");
    const response = await fetch("/api/leases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, mode, force }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.acquired !== true || !result.lease || typeof result.lease !== "object") {
      throw new Error(result.message || `${deviceLabel(device)} 控制权获取失败`);
    }
    const lease = result.lease;
    setDevices((current) => current.map((item) => item.deviceId === device.deviceId ? { ...item, lease } : item));
    return lease;
  }

  async function selectDevice(device) {
    if (!device?.deviceId) return;
    setSelectedDeviceId(device.deviceId);
    if (leaseBusy || !device.online) return;
    setLeaseBusy(true);
    setFeedback(`正在接管 ${deviceLabel(device)}…`);
    try {
      await acquireLease(device, "manual");
      setFeedback(`已接管 ${deviceLabel(device)}，其他控制已自动释放`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setLeaseBusy(false);
    }
  }

  async function releaseLease(device, force = false) {
    const response = await fetch("/api/leases", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, force }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.released === false) {
      throw new Error(result.message || `${deviceLabel(device)} 控制权释放失败`);
    }
    setDevices((current) => current.map((item) => item.deviceId === device.deviceId ? { ...item, lease: null } : item));
  }

  async function sendCommand(device, mode, override = null) {
    if (auth.authenticated && mode !== "stop") {
      const lease = device.lease;
      if (!lease || lease.ownerEmail !== auth.user?.email) {
        await acquireLease(device, "manual");
      }
    }
    const params = override || { frequency: device.frequency ?? 2.5, amplitudePercent: DEFAULT_AMPLITUDE_PERCENT };
    const payload = {
      deviceId: device.deviceId, mode,
      frequency: clamp(params.frequency, 0.3, 5, 2.5),
      amplitudePercent: clamp(params.amplitudePercent ?? params.amplitude, 0, 100, DEFAULT_AMPLITUDE_PERCENT),
    };
    if (params.bias !== undefined && params.bias !== null && mode !== "left" && mode !== "right") {
      payload.bias = clamp(params.bias, -90, 90, 0);
    }
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.sent === false || result.acknowledged !== true || result.success !== true) {
      throw new Error(result.message || `${deviceLabel(device)} 未确认应用`);
    }
    if (result.applied) {
      setDevices((current) => current.map((item) => item.deviceId === device.deviceId ? { ...item, ...result.applied } : item));
    }
    return result;
  }

  async function sendRealtimeCommand(device, mode) {
    const payload = {
      deviceId: device.deviceId,
      mode,
      frequency: clamp(device.frequency ?? 2.5, 0.3, 5, 2.5),
      amplitudePercent: clamp(amplitudePercentFromDevice(device), 0, 100, DEFAULT_AMPLITUDE_PERCENT),
    };
    if (device.bias !== undefined && device.bias !== null && mode !== "left" && mode !== "right") {
      payload.bias = clamp(device.bias, -90, 90, 0);
    }
    const response = await fetch("/api/command/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.sent === false || result.queued !== true) {
      throw new Error(result.message || `${deviceLabel(device)} 实时命令未发送`);
    }
    return result;
  }

  function reportKeyboardError(error) {
    const now = Date.now();
    if (now - keyboardRef.current.lastErrorAt < 1000) return;
    keyboardRef.current.lastErrorAt = now;
    setFeedback(error.message);
  }

  function sendKeyboardFrame(mode, targetDevice = null) {
    const current = manualControlRef.current;
    const device = targetDevice || current.selectedDevice;
    if (!current.authenticated || current.page !== "manual" || !device) return;
    const send = () => sendRealtimeCommand(device, mode);
    if (mode !== "stop" && (!device.lease || device.lease.ownerEmail !== current.currentUserEmail)) {
      if (keyboardRef.current.leasePromise) return;
      setLeaseBusy(true);
      keyboardRef.current.leasePromise = acquireLease(device, "manual")
        .then(() => {
          if (!keyboardRef.current.active || !keyboardRef.current.lastMode) return null;
          return send();
        })
        .catch((error) => {
          stopKeyboardControl(device);
          reportKeyboardError(error);
        })
        .finally(() => {
          keyboardRef.current.leasePromise = null;
          setLeaseBusy(false);
        });
      return;
    }
    send().catch(reportKeyboardError);
  }

  function stopKeyboardControl(targetDevice = null) {
    const state = keyboardRef.current;
    if (state.timer !== null) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    const shouldStop = state.active || state.lastMode;
    state.active = false;
    state.lastMode = "";
    if (shouldStop) sendKeyboardFrame("stop", targetDevice);
  }

  function updateKeyboardControl() {
    const state = keyboardRef.current;
    const current = manualControlRef.current;
    if (!current.authenticated || current.page !== "manual" || !current.selectedDevice) {
      stopKeyboardControl();
      return;
    }
    const mode = keyboardMode(state.pressed);
    if (mode === "stop") {
      stopKeyboardControl();
      return;
    }
    state.active = true;
    state.lastMode = mode;
    if (state.timer === null) {
      state.timer = window.setInterval(() => {
        if (state.leasePromise) return;
        const nextMode = keyboardMode(state.pressed);
        if (nextMode === "stop") {
          stopKeyboardControl();
          return;
        }
        state.lastMode = nextMode;
        sendKeyboardFrame(nextMode);
      }, KEYBOARD_TICK_MS);
    }
    sendKeyboardFrame(mode);
  }

  useEffect(() => {
    function onKeyDown(event) {
      if (!KEYBOARD_CODES.has(event.code) || isTypingTarget(event.target)) return;
      event.preventDefault();
      const state = keyboardRef.current;
      if (state.pressed.has(event.code)) return;
      state.pressed.add(event.code);
      updateKeyboardControl();
    }
    function onKeyUp(event) {
      if (!KEYBOARD_CODES.has(event.code) || isTypingTarget(event.target)) return;
      event.preventDefault();
      keyboardRef.current.pressed.delete(event.code);
      updateKeyboardControl();
    }
    function releaseKeyboard() {
      keyboardRef.current.pressed.clear();
      stopKeyboardControl();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseKeyboard);
    function onVisibilityChange() {
      if (document.hidden) releaseKeyboard();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseKeyboard);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseKeyboard();
    };
  }, []);

  useEffect(() => {
    if (page !== "manual" || !auth.authenticated) {
      keyboardRef.current.pressed.clear();
      stopKeyboardControl();
    }
  }, [auth.authenticated, page]);

  async function stopAll() {
    if (!onlineDevices.length || sending) return;
    setSending(true);
    setFeedback(`ALL STOP：正在停止 ${onlineDevices.length} 台在线设备…`);
    try {
      const response = await fetch("/api/emergency-stop", { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "紧急停止失败，需要管理员权限");
      const failed = (result.results || []).filter((item) => !item.sent || !item.acknowledged || !item.success).length;
      setFeedback(failed ? `ALL STOP 完成，${failed} 台未确认` : `ALL STOP 完成 · ${(result.results || []).length} 台`);
    } catch (stopError) {
      setFeedback(stopError.message);
    }
    setSending(false);
  }

  function deviceNeutralCenter(device) {
    const saved = calibrationProfiles[device.deviceId];
    return clamp(saved?.straightCenter ?? saved?.centerDeg ?? 90 + Number(device.bias ?? 0), 0, 180, 90);
  }

  function updateLocalNeutral(device, center) {
    const saved = calibrationProfiles[device.deviceId] || {};
    const profile = {
      deviceId: device.deviceId,
      servoMin: saved.servoMin ?? 0,
      servoMax: saved.servoMax ?? 180,
      straightCenter: Number(center),
      forwardFrequency: saved.forwardFrequency ?? saved.frequency ?? Number(device.frequency ?? 2.5),
      forwardAmplitudePercent: saved.forwardAmplitudePercent ?? DEFAULT_AMPLITUDE_PERCENT / 100,
      leftCenterRatio: saved.leftCenterRatio ?? 0.5,
      leftFrequency: saved.leftFrequency ?? 2.3,
      leftAmplitudePercent: saved.leftAmplitudePercent ?? DEFAULT_AMPLITUDE_PERCENT / 100,
      rightCenterRatio: saved.rightCenterRatio ?? 0.5,
      rightFrequency: saved.rightFrequency ?? 2.3,
      rightAmplitudePercent: saved.rightAmplitudePercent ?? DEFAULT_AMPLITUDE_PERCENT / 100,
      transitionMs: saved.transitionMs ?? 600,
    };
    setCalibrationProfiles((current) => ({ ...current, [device.deviceId]: profile }));
    return profile;
  }

  async function saveDeviceNeutral(device, center) {
    const profile = updateLocalNeutral(device, center);
    try {
      const response = await fetch("/api/motion-calibrations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      if (!response.ok) throw new Error((await response.text()).trim() || "保存失败");
      const saved = await response.json();
      setCalibrationProfiles((current) => ({ ...current, [device.deviceId]: saved }));
      if (device.online) {
        await sendCommand(device, "center", { frequency: profile.forwardFrequency, amplitude: 0, bias: Number(center) - 90 });
      }
      setOtaFeedback(`${deviceLabel(device)} 舵机中位已保存：${center}°`);
    } catch (neutralError) {
      setOtaFeedback(`中位保存失败：${neutralError.message}`);
    }
  }

  async function uploadFirmware() {
    if (!firmwareFile || uploading) { setOtaFeedback("请先从电脑选择 firmware.bin"); return; }
    if (!firmwareFile.name.toLowerCase().endsWith(".bin")) { setOtaFeedback("只允许上传 .bin 文件"); return; }
    if (firmwareFile.size > 8 * 1024 * 1024) { setOtaFeedback("固件超过 8 MB 上限"); return; }
    setUploading(true);
    setOtaFeedback("正在上传并校验固件…");
    try {
      const form = new FormData();
      form.append("firmware", firmwareFile);
      const response = await fetch("/api/firmware", { method: "POST", body: form });
      const raw = await response.text();
      if (!response.ok) throw new Error(raw.trim() || "上传失败");
      const info = JSON.parse(raw);
      setFirmwareInfo(info);
      setOtaFeedback(`固件已就绪 · ${info.name} · ${formatBytes(info.size)}`);
    } catch (uploadError) {
      setOtaFeedback(`上传失败：${uploadError.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function startOta() {
    if (!firmwareInfo.available) { setOtaFeedback("请先上传有效的 firmware.bin"); return; }
    if (!otaSelectedDevices.length || sending) { setOtaFeedback("请至少选择一台在线设备作为 OTA 目标"); return; }
    if (!window.confirm(`确定使用 ${firmwareInfo.name || "当前固件"} 升级 ${otaSelectedDevices.length} 台设备？升级期间设备会停止并重启。`)) return;
    setSending(true);
    setOtaFeedback(`正在向 ${otaSelectedDevices.length} 台设备创建 OTA 任务…`);
    const results = await Promise.allSettled(otaSelectedDevices.map(async (device) => {
      const response = await fetch("/api/ota", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.sent === false || result.acknowledged !== true || result.success !== true) throw new Error(result.message || "开发板未确认 OTA 完成");
      return result;
    }));
    const failed = results.filter((result) => result.status === "rejected").length;
    setOtaFeedback(failed ? `OTA 确认 ${results.length - failed}/${results.length} 台，${failed} 台失败` : `开发板已确认 OTA 写入完成 · ${results.length} 台`);
    setSending(false);
  }

  async function setRgb(device, mode) {
    const red = parseInt(rgbColor.slice(1, 3), 16), green = parseInt(rgbColor.slice(3, 5), 16), blue = parseInt(rgbColor.slice(5, 7), 16);
    setOtaFeedback(`正在等待 ${deviceLabel(device)} 确认 RGB 设置…`);
    try {
      const response = await fetch("/api/rgb", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({deviceId:device.deviceId,mode,order:rgbOrder,red,green,blue,brightness:Number(rgbBrightness)}) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.acknowledged !== true || result.success !== true) throw new Error(result.message || "RGB 设置失败");
      setOtaFeedback(mode === "AUTO" ? `${deviceLabel(device)} 已恢复自动状态灯` : `${deviceLabel(device)} 已确认 RGB 颜色`);
    } catch (rgbError) { setOtaFeedback(`RGB 设置失败：${rgbError.message}`); }
  }

  if (auth.loading) {
    return <main className="auth-loading">正在载入控制台…</main>;
  }
  if (!auth.authenticated) {
    return <AuthScreen bootstrap={auth.bootstrap} onAuthenticated={(user) => setAuth({ loading: false, authenticated: true, bootstrap: false, user })} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">鱼</div>
          <div><span className="eyebrow">FISH CONTROL</span><h1>多鱼控制平台</h1></div>
        </div>
        <nav className="page-tabs" aria-label="页面切换">
          <button className={page === "manual" ? "active" : ""} onClick={() => setPage("manual")}>手动</button>
          <button className={page === "vision" ? "active" : ""} onClick={() => setPage("vision")}>视觉</button>
          <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>设置</button>
        </nav>
        <div className="system-status top-actions">
          <span className="user-pill">{auth.user?.name || auth.user?.email}<small>{auth.user?.role}</small></span>
          <span className="top-metric"><b>{onlineDevices.length}</b><small>在线 / {devices.length}</small></span>
          <span className={`top-metric battery-metric ${lowBatteryCount ? "critical" : ""}`}><b>{lowBatteryCount}</b><small>低电量</small></span>
          <span className="status online"><i /> Controller</span>
          <button className="top-stop" disabled={!onlineDevices.length || sending} onClick={stopAll}>ALL STOP</button>
          <button className="logout-button" onClick={logout}>退出</button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}，正在自动重试。</div>}

      {page !== "settings" ? (
        <div className={`workspace ${page}-workspace`}>
          <section className="center-column">
            {page === "vision" ? <VisionPanel devices={devices} targetDeviceId={visionDeviceId} onTargetDeviceChange={setVisionDeviceId} /> : (
              <>
                <ManualVideoPreview />
              </>
            )}
          </section>

          {page === "manual" && <aside className="control-sidebar panel-surface">
            <section className="control-section manual-list-section">
              <div className="panel-heading compact">
                <div><span className="eyebrow">MANUAL</span><h2>在线鱼列表</h2><small>点击一条鱼即可接管，系统会自动释放你上一条鱼。</small></div>
                <span className="fish-status-pill"><i />{onlineDevices.length} 条在线</span>
              </div>
              <div className="manual-fish-table" role="list" aria-label="在线机器鱼">
                <div className="manual-fish-table-head" aria-hidden="true">
                  <span>鱼名</span>
                  <span>状态</span>
                  <span>控制者</span>
                  <span>电量</span>
                </div>
                {onlineDevices.length ? onlineDevices.map((device) => {
                  const selected = selectedDeviceId === device.deviceId;
                  const owner = device.lease ? (device.lease.ownerName || device.lease.ownerEmail) : "空闲";
                  const battery = batteryLevel(device);
                  return <button
                    key={device.deviceId}
                    type="button"
                    className={`manual-fish-row ${selected ? "selected" : ""}`}
                    onClick={() => selectDevice(device)}
                    disabled={leaseBusy}
                    role="listitem"
                  >
                    <span className="manual-fish-name">{deviceLabel(device)}</span>
                    <span className={`manual-fish-state ${device.lease ? "busy" : "free"}`}>{device.lease ? "被控" : "空闲"}</span>
                    <span className="manual-fish-owner">{owner}</span>
                    <span className="manual-fish-battery">{battery != null ? `${battery}%` : "—"}</span>
                  </button>;
                }) : <div className="list-row"><strong>暂无在线鱼</strong><span>设备上线后会出现在这里。</span></div>}
              </div>
              <p className="feedback" aria-live="polite">{feedback}</p>
            </section>
          </aside>}
        </div>
      ) : (
        <div className="settings-grid">
          <article className="settings-card">
            <h2>登录与权限</h2>
            <div className="settings-list">
              <div className="list-row"><strong>当前用户 <span>{auth.user?.role || "—"}</span></strong><span>{auth.user?.email || auth.user?.name || "—"}</span></div>
              <div className="list-row"><strong>控制规则 <span>互斥</span></strong><span>一条鱼同一时间只允许一个人控制；控制者会显示在鱼池和鱼卡上。</span></div>
              <div className="list-row"><strong>在线状态 <span>{onlineDevices.length}/{devices.length}</span></strong><span>低电量设备：{lowBatteryCount} 台</span></div>
            </div>
            <div className="settings-actions">
              <button className="ghost-action" type="button" onClick={logout}>退出登录</button>
              <button className="danger" type="button" disabled={!onlineDevices.length || sending} onClick={stopAll}>全部停止</button>
            </div>
          </article>

          <article className="settings-card">
            <h2>设备与固件</h2>
            <div className="firmware-status">
              <span className={`firmware-ready ${firmwareInfo.available ? "ready" : ""}`}>{firmwareInfo.available ? "READY" : "NO FIRMWARE"}</span>
              <small>{firmwareInfo.available ? `${firmwareInfo.name} · ${formatBytes(firmwareInfo.size)}` : "请选择电脑上的 firmware.bin"}</small>
            </div>
            <label className="local-bin-picker"><input type="file" accept=".bin,application/octet-stream" onChange={(event) => { setFirmwareFile(event.target.files?.[0] || null); setOtaFeedback("文件已选择，等待上传"); }} /><strong>{firmwareFile ? firmwareFile.name : "选择固件 BIN"}</strong><small>用于 ESP32 OTA 升级</small></label>
            {firmwareFile && <div className="local-file-meta"><span>本地文件</span><b>{firmwareFile.name}</b><span>大小</span><b>{formatBytes(firmwareFile.size)}</b></div>}
            {firmwareInfo.available && <div className="firmware-meta compact"><div><span>SHA-256</span><code>{firmwareInfo.sha256}</code></div></div>}
            <div className="settings-actions">
              <button className="action" type="button" disabled={!firmwareFile || uploading} onClick={uploadFirmware}>{uploading ? "上传校验中…" : "上传固件"}</button>
              <button className="ghost-action" type="button" disabled={!firmwareInfo.available || !otaSelectedDevices.length || sending || uploading} onClick={startOta}>OTA 下发 {otaSelectedDevices.length ? `(${otaSelectedDevices.length})` : ""}</button>
            </div>
            <div className="ota-target-header"><div><span className="sidebar-label no-pad">升级目标</span><small>已选择 {otaSelectedDevices.length} 台</small></div><div><button onClick={selectOtaOnline}>全选在线</button><button onClick={() => setOtaSelectedIds(new Set())}>取消选择</button></div></div>
            <div className="ota-device-grid">{devices.map((device) => {
              const selected = otaSelectedIds.has(device.deviceId);
              return <button key={device.deviceId} className={`ota-device-card ${selected ? "selected" : ""}`} disabled={!device.online} onClick={() => toggleSet(setOtaSelectedIds, device.deviceId)}>
                <span className="device-check">{selected ? "✓" : ""}</span><span><strong>{deviceLabel(device)}</strong><small>{device.deviceId}</small></span><em>{device.online ? "在线" : "离线"}</em>
              </button>;
            })}</div>
            <p className="feedback" aria-live="polite">{otaFeedback}</p>
          </article>

          <article className="settings-card settings-card-wide">
            <h2>舵机与平台</h2>
            <div className="device-info-list clean-device-list">{devices.map((device) => <article className="device-info-card clean-device-card" key={device.deviceId}>
              <header><strong>{deviceLabel(device)}</strong><span className={device.online ? "online-text" : "offline-text"}>{device.online ? "● 在线" : "○ 离线"}</span></header>
              <div className="settings-list">
                <div className="list-row"><strong>固件 <span>{device.firmwareVersion || "—"}</span></strong><span>{device.mac || device.deviceId || "—"}</span></div>
                <div className="list-row"><strong>电量 <span>{device.online && Number.isFinite(device.batteryVoltage) && device.batteryVoltage > 0 ? `${device.batteryPercent}%` : "—"}</span></strong><span>{device.online && device.rssi ? `${device.rssi} dBm` : "信号未知"}</span></div>
                <div className="list-row"><strong>状态 <span>{MODE_LABELS[device.mode] || "未知"}</span></strong><span>{device.stopReason || `最后在线：${formatTime(device.lastSeen)}`}</span></div>
              </div>
              <label className="setting">舵机中位 <b>{Number(deviceNeutralCenter(device)).toFixed(0)}°</b>
                <input type="range" min="45" max="135" step="1" value={deviceNeutralCenter(device)} disabled={sending} onChange={(event) => updateLocalNeutral(device, event.target.value)} onPointerUp={(event) => saveDeviceNeutral(device, event.currentTarget.value)} onKeyUp={(event) => saveDeviceNeutral(device, event.currentTarget.value)} />
              </label>
              <div className="rgb-controls"><label><span>RGB 颜色</span><input type="color" value={rgbColor} onChange={(event) => setRgbColor(event.target.value)} /></label><label><span>灯珠色序</span><select value={rgbOrder} onChange={(event) => setRgbOrder(event.target.value)}>{["RGB","GRB","RBG","GBR","BRG","BGR"].map((order) => <option key={order}>{order}</option>)}</select></label><label><span>亮度 {rgbBrightness}</span><input type="range" min="1" max="255" value={rgbBrightness} onChange={(event) => setRgbBrightness(event.target.value)} onPointerUp={() => setRgb(device, device.rgbMode === "SOLID" ? "SOLID" : "AUTO")} onKeyUp={() => setRgb(device, device.rgbMode === "SOLID" ? "SOLID" : "AUTO")} /></label><small>松开滑块后立即下发，并等待开发板确认。</small><div><button type="button" disabled={!device.online} onClick={() => setRgb(device,"SOLID")}>应用颜色</button><button type="button" disabled={!device.online} onClick={() => setRgb(device,"AUTO")}>自动模式</button></div></div>
              <div className="device-card-actions"><button type="button" onClick={() => openRename(device)}>✎ 重命名设备</button></div>
            </article>)}
            {!devices.length && <div className="list-row"><strong>等待设备 <span>ESP32</span></strong><span>机器鱼上线后这里会显示舵机中位和固件状态。</span></div>}
            </div>
          </article>
          {auth.user?.role === "Admin" && <AdminUsers currentUser={auth.user} />}
        </div>
      )}

      {renameDevice && <div className="rename-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRename(); }}>
        <section className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title">
          <div className="rename-dialog-head"><div><span className="eyebrow">RENAME DEVICE</span><h2 id="rename-title">重命名设备</h2></div><button className="rename-close" onClick={closeRename} aria-label="关闭">×</button></div>
          <div className="rename-dialog-body">
            <label className="rename-field"><span>设备名称</span><input autoFocus maxLength="24" value={renameDraft} onChange={(event) => { setRenameDraft(event.target.value); setRenameError(""); }} onKeyDown={(event) => { if (event.key === "Enter") saveRename(); }} /></label>
            {renameError && <p className="rename-error">{renameError}</p>}
            <div className="rename-readonly"><span>MAC 地址 · 不可修改</span><b>{renameDevice.mac || renameDevice.deviceId || "—"}</b></div>
            <div className="rename-readonly"><span>Device ID · 不可修改</span><b>{renameDevice.deviceId || "—"}</b></div>
            <p className="rename-note">名称必须全局唯一；比较时忽略大小写，例如 Fish01、fish01、FISH01 会被视为同名。</p>
          </div>
          <div className="rename-dialog-actions"><button onClick={closeRename}>取消</button><button className="save" onClick={saveRename}>保存名称</button></div>
        </section>
      </div>}

      <footer className="app-footer"><span>{page === "vision" ? "视觉：识别、跟踪、自动控制" : page === "manual" ? "手动：在线鱼列表和单鱼接管" : "设置：账号、固件、设备和舵机中位"}</span><span>{page === "vision" ? `视觉目标 ${onlineDevices.length} 台` : page === "manual" ? (selectedDevice ? deviceLabel(selectedDevice) : "未选择设备") : `OTA 目标 ${otaSelectedDevices.length} 台`}</span></footer>
    </main>
  );
}

class AppErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Fish Control render error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-error" role="alert">
        <section>
          <span className="eyebrow">FISH CONTROL</span>
          <h1>控制台暂时无法显示</h1>
          <p>页面状态出现异常，设备不会继续接收新的网页操作。</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载页面</button>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById("root")).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
