import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./maintenance.css";
import "./rename.css";
import VisionPanel from "./VisionPanel.jsx";
import { chooseCameraIndex } from "./coordinates.js";
import { visionRequest, visionStreamUrl } from "./visionSession.js";
import { formatFrameLatency, formatVideoClock } from "./videoTime.js";
import { motionRange } from "./motionCalibration.js";

const MODE_LABELS = {
  stop: "停止", idle: "待机", forward: "前进", left: "左转", right: "右转",
  0: "停止", 1: "待机", 2: "前进", 3: "左转", 4: "右转",
};
const ACTIONS = [["left", "左转"], ["forward", "前进"], ["right", "右转"], ["idle", "IDLE"]];
const ALIAS_STORAGE_KEY = "fish-controller-device-aliases-v1";
const CALIBRATION_STORAGE_KEY = "fish-controller-motion-calibration-v1";
const MODE_NAMES = { 0: "stop", 1: "idle", 2: "forward", 3: "left", 4: "right" };
const DEFAULT_AMPLITUDE_PERCENT = 40;

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
function cameraLabel(camera) {
  const model = camera.model || camera.name || `摄像头 ${camera.index}`;
  const size = camera.width && camera.height ? `${camera.width}×${camera.height}` : "";
  const fps = camera.fps ? `${camera.fps}FPS` : "";
  return [`#${camera.index}`, model, [size, fps].filter(Boolean).join(" @ ")].filter(Boolean).join(" · ");
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
  const [videoBusy, setVideoBusy] = useState(false);
  const [overlayPrefs, setOverlayPrefs] = useState(DEFAULT_OVERLAYS);
  const [clock, setClock] = useState(() => formatVideoClock());
  const streamRetryTimerRef = useRef(null);

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

  useEffect(() => {
    const tick = () => setClock(formatVideoClock());
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
        setCameras(cameraList);
        setStatus(nextStatus);
        setCameraIndex((current) => chooseCameraIndex(current, cameraList, nextStatus));
      } catch (error) {
        if (active) setFeedback(error.message);
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!running) {
      if (streamRetryTimerRef.current) window.clearTimeout(streamRetryTimerRef.current);
      streamRetryTimerRef.current = null;
      setStreamFeedback("");
      setStreamRetry(0);
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
    setStreamFeedback("视频流中断，正在自动重连…");
    updateStreamRetry();
  }

  function handleStreamReady() {
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
        {running ? <img src={visionStreamUrl(status.sessionId, streamRetry)} onError={handleStreamError} onLoad={handleStreamReady} alt="手动控制摄像头画面" draggable="false" /> : <div className="video-placeholder"><strong>驾驶视角未开启</strong><span>选择摄像头后开始监看</span></div>}
        {running && <div className="video-badge">本机 {clock}{latencyLabel}<br />{videoWidth} × {videoHeight}</div>}
      </div>
      <div className="manual-video-controls">
        <label className="camera-select">摄像头<select value={cameraIndex} disabled={running} onChange={(event) => setCameraIndex(event.target.value)}><option value="">请选择摄像头</option>{cameras.map((camera) => <option key={camera.index} value={camera.index}>{cameraLabel(camera)}</option>)}</select></label>
        <div className="manual-video-actions">
          <button disabled={videoBusy || running || cameraIndex === ""} onClick={startPreview}>{videoBusy ? "打开中…" : "开启监看"}</button>
          <button disabled={videoBusy || !running || tracking} onClick={toggleProcessing}>{tracking ? "循迹中" : processing ? "关闭识别" : "叠加识别"}</button>
          <button className="stop" disabled={videoBusy || !running || tracking} onClick={stopPreview}>关闭</button>
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

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("陈富坤");
  const [email, setEmail] = useState("chenfukun@example.com");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [role, setRole] = useState("Operator");
  const [remember, setRemember] = useState(true);
  const [feedback, setFeedback] = useState("当前：电脑/平板/手机会自动适配；请使用本地账号登录。");
  const [busy, setBusy] = useState(false);

  async function submitAuth(event) {
    event.preventDefault();
    if (busy) return;
    if (mode === "register" && password !== confirmPassword) {
      setFeedback("两次密码不一致");
      return;
    }
    setBusy(true);
    setFeedback(mode === "login" ? "正在登录…" : "正在提交注册…");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { email, password } : { name, email, password, invite, role }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.authenticated === false) {
        throw new Error(result.message || (mode === "login" ? "登录失败" : "注册后需要管理员审批"));
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

          <section className="auth-card" aria-label="登录注册">
            <div className="auth-tabs" role="tablist" aria-label="Login or register">
              <button className={mode === "login" ? "active" : ""} aria-selected={mode === "login"} type="button" onClick={() => setMode("login")}>登录</button>
              <button className={mode === "register" ? "active" : ""} aria-selected={mode === "register"} type="button" onClick={() => setMode("register")}>注册</button>
            </div>

            <div className="auth-form-head">
              <h2>{mode === "login" ? "登录账号" : "注册成员"}</h2>
              <p>{mode === "login" ? "Cloudflare Access 可作为后续入口；当前使用本地账号登录。" : "需要邀请码、密码和管理员审批，避免陌生人直接创建控制账号。"}</p>
            </div>

            <form className="auth-form" onSubmit={submitAuth}>
              {mode === "login" && <>
                <button className="auth-primary" type="button" onClick={() => setFeedback("Cloudflare Access 入口已预留；如果要正式启用，我下一步可以接 Cloudflare Zero Trust。")}>使用 Cloudflare Access 登录</button>
                <div className="auth-divider">或使用本地账号</div>
              </>}

              {mode === "register" && <label className="auth-field"><span>邀请码</span><input value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="请输入团队邀请码" /></label>}

              {mode === "register" ? <div className="auth-two-col">
                <label className="auth-field"><span>姓名</span><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
                <label className="auth-field"><span>邮箱</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
              </div> : <label className="auth-field"><span>邮箱</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>}

              {mode === "register" ? <div className="auth-two-col">
                <label className="auth-field"><span>设置密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label>
                <label className="auth-field"><span>确认密码</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label>
              </div> : <label className="auth-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>}

              {mode === "login" && <div className="auth-helper-row">
                <label className="auth-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> 保持登录</label>
                <button type="button" onClick={() => setFeedback("当前版本还没有接入找回密码；管理员可以在服务器端重置账号。")}>忘记密码</button>
              </div>}

              {mode === "register" && <label className="auth-field"><span>申请角色</span><select value={role} onChange={(event) => setRole(event.target.value)}><option value="Viewer">Viewer：只能查看</option><option value="Operator">Operator：可以申请控制鱼</option><option value="Admin">Admin：需要管理员批准</option></select></label>}

              <button className={mode === "login" ? "auth-secondary" : "auth-primary"} disabled={busy}>{busy ? "请稍候…" : mode === "login" ? "进入控制台" : "提交注册申请"}</button>
              <p className="auth-feedback" aria-live="polite">{feedback}</p>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

function App() {
  const [auth, setAuth] = useState({ loading: true, authenticated: false, bootstrap: false, user: null });
  const [page, setPage] = useState("manual");
  const [devices, setDevices] = useState([]);
  const [aliases, setAliases] = useState(loadAliases);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [otaSelectedIds, setOtaSelectedIds] = useState(() => new Set());
  const [paramMode, setParamMode] = useState("sync");
  const [frequency, setFrequency] = useState(2.5);
  const [amplitude, setAmplitude] = useState(28);
  const [bias, setBias] = useState(0);
  const [activeMode, setActiveMode] = useState("");
  const [feedback, setFeedback] = useState("等待控制指令");
  const [sending, setSending] = useState(false);
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
  const selectedDevices = useMemo(() => devices.filter((device) => selectedIds.has(device.deviceId)), [devices, selectedIds]);
  const selectedOnline = useMemo(() => selectedDevices.filter((device) => device.online), [selectedDevices]);
  const parameterSelectionKey = useMemo(() => selectedDevices.map((device) => device.deviceId).sort().join("|"), [selectedDevices]);
  const otaSelectedDevices = useMemo(() => devices.filter((device) => otaSelectedIds.has(device.deviceId) && device.online), [devices, otaSelectedIds]);
  const selectedBattery = useMemo(() => {
    const measured = selectedDevices.filter((device) => batteryLevel(device) != null);
    if (!measured.length) return null;
    return measured.reduce((lowest, device) => batteryLevel(device) < batteryLevel(lowest) ? device : lowest);
  }, [selectedDevices]);
  useEffect(() => {
    if (!auth.authenticated) return;
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/devices", { cache: "no-store" });
        if (!response.ok) throw new Error("控制器接口不可用");
        const data = await response.json();
        if (!active) return;
        const raw = Array.isArray(data) ? data : [];
        const next = raw.map((device) => ({ ...device, name: aliases[device.deviceId] || device.name }));
        setDevices(next);
        setError("");
        const valid = new Set(next.map((device) => device.deviceId));
        setSelectedIds((current) => new Set([...current].filter((id) => valid.has(id))));
        setOtaSelectedIds((current) => new Set([...current].filter((id) => valid.has(id) && next.find((d) => d.deviceId === id)?.online)));
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    }
    load();
    const timer = window.setInterval(load, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [aliases, auth.authenticated]);

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

  useEffect(() => {
    if (selectedDevices.length !== 1 || sending) return;
    const [device] = selectedDevices;
    setFrequency(device.frequency ?? 2.5);
      setAmplitude(amplitudePercentFromDevice(device));
    setBias(device.bias ?? 0);
  }, [parameterSelectionKey]);

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
    setSelectedIds(new Set());
    setOtaSelectedIds(new Set());
  }

  async function acquireLease(device, mode = "manual", force = false) {
    const response = await fetch("/api/leases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, mode, force }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.acquired === false) {
      throw new Error(result.message || `${deviceLabel(device)} 控制权获取失败`);
    }
    setDevices((current) => current.map((item) => item.deviceId === device.deviceId ? { ...item, lease: result.lease } : item));
    return result.lease;
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
      payload.bias = clamp(params.bias, -45, 45, 0);
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

  async function applyParameters() {
    if (paramMode !== "sync" || !selectedOnline.length || sending) {
      if (!selectedOnline.length) setFeedback("请选择至少一台在线机器鱼");
      return;
    }
    setSending(true);
    setFeedback(`参数已发送，等待 ${selectedOnline.length} 台开发板确认…`);
    const params = { frequency, amplitudePercent: amplitude, bias };
    const results = await Promise.allSettled(selectedOnline.map((device) => sendCommand(device, activeMode || MODE_NAMES[device.mode] || "stop", params)));
    const failed = results.filter((result) => result.status === "rejected");
    setFeedback(failed.length
      ? `开发板确认 ${results.length - failed.length}/${results.length} 台：${failed[0].reason?.message || "部分设备失败"}`
      : `开发板已确认应用：${Number(frequency).toFixed(1)} Hz · 幅度 ${amplitude}% · ${Number(bias) > 0 ? "+" : ""}${bias}°`);
    setSending(false);
  }

  async function sendToSelection(mode) {
    if (!selectedOnline.length || sending) { if (!selectedOnline.length) setFeedback("请先选择至少一台在线机器鱼"); return; }
    setSending(true);
    setFeedback(`正在向 ${selectedOnline.length} 台设备发送 ${MODE_LABELS[mode] || mode}…`);
    const shared = paramMode === "sync" ? { frequency, amplitudePercent: amplitude, bias } : null;
    const results = await Promise.allSettled(selectedOnline.map((device) => sendCommand(device, mode, shared)));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (mode === "stop") setActiveMode(""); else if (!failed) setActiveMode(mode);
    setFeedback(failed ? `开发板确认 ${results.length - failed}/${results.length} 台，${failed} 台失败` : `开发板已确认：${MODE_LABELS[mode] || mode} · ${results.length} 台设备`);
    setSending(false);
  }

  async function stopAll() {
    if (!onlineDevices.length || sending) return;
    setSending(true);
    setFeedback(`ALL STOP：正在停止 ${onlineDevices.length} 台在线设备…`);
    try {
      const response = await fetch("/api/emergency-stop", { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "紧急停止失败，需要管理员权限");
      const failed = (result.results || []).filter((item) => !item.sent || !item.acknowledged || !item.success).length;
      setActiveMode("");
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

  const targetTitle = selectedDevices.length === 0 ? "未选择设备" : selectedDevices.length === 1 ? deviceLabel(selectedDevices[0]) : `已选择 ${selectedDevices.length} 台`;
  const primaryDevice = selectedDevices[0] || onlineDevices[0] || devices[0] || null;
  const displayDevices = devices.length ? devices : [
    { deviceId: "fish-a", name: "鱼 A", online: false },
    { deviceId: "fish-b", name: "鱼 B", online: false },
    { deviceId: "fish-c", name: "鱼 C", online: false },
  ];

  if (auth.loading) {
    return <main className="auth-loading">正在载入控制台…</main>;
  }
  if (!auth.authenticated) {
    return <AuthScreen onAuthenticated={(user) => setAuth({ loading: false, authenticated: true, bootstrap: false, user })} />;
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
            <section className="manual-pond-card manual-selection-card">
              <div className="panel-heading">
                <div><span className="eyebrow">MANUAL</span><h2>手动控制</h2><small>选鱼 → 获取控制权 → 控制方向</small></div>
                <span className="fish-status-pill"><i />{onlineDevices.length} 条在线</span>
              </div>
              <div className="manual-pond">
                {displayDevices.slice(0, 6).map((device, index) => {
                  const selected = selectedIds.has(device.deviceId);
                  const leaseText = device.lease ? `${device.lease.ownerName || device.lease.ownerEmail}` : "空闲";
                  return <button key={device.deviceId || index} type="button" className={`manual-fish-node node-${index + 1} ${selected ? "selected" : ""}`} disabled={!device.online && devices.length > 0} onClick={() => setSelectedIds(new Set([device.deviceId]))}>
                    <strong>{deviceLabel(device)}</strong>
                    <span>{device.online ? leaseText : "离线"}</span>
                  </button>;
                })}
              </div>
              <div className="manual-summary-strip">
                {displayDevices.slice(0, 6).map((device) => {
                  const selected = selectedIds.has(device.deviceId);
                  const owner = device.lease ? device.lease.ownerName || device.lease.ownerEmail : "空闲，可以接管";
                  return <button key={device.deviceId} className={`fish-card ${selected ? "selected" : ""}`} disabled={!device.online && devices.length > 0} onClick={() => setSelectedIds(new Set([device.deviceId]))}>
                    <strong>{deviceLabel(device)}</strong><span>{device.online ? owner : "离线"}</span>
                  </button>;
                })}
                {!devices.length && <button className="fish-card"><strong>等待设备</strong><span>ESP32 上线后显示真实机器鱼</span></button>}
              </div>
            </section>

            <section className="control-section target-section">
              <div className="panel-heading compact"><div><span className="eyebrow">CURRENT FISH</span><h2>当前鱼</h2><small>{primaryDevice ? (primaryDevice.lease ? `${deviceLabel(primaryDevice)} 被 ${primaryDevice.lease.ownerName || primaryDevice.lease.ownerEmail} 控制` : `${deviceLabel(primaryDevice)} 可以控制`) : "尚未发现设备"}</small></div></div>
              <div className="current-name">
                <strong>{targetTitle}</strong>
                <span className="fish-status-pill">{selectedOnline.length ? "在线" : "未选择"}</span>
              </div>
              <div className="kv">
                <div><span>控制者</span><strong>{primaryDevice?.lease ? primaryDevice.lease.ownerName || primaryDevice.lease.ownerEmail : "无人"}</strong></div>
                <div><span>电量</span><strong>{selectedBattery && batteryLevel(selectedBattery) != null ? `${batteryLevel(selectedBattery)}%` : "—"}</strong></div>
                <div><span>连接</span><strong>{primaryDevice?.online ? "ESP32 在线" : "离线"}</strong></div>
              </div>
              {selectedDevices.length > 1 && <div className="selected-chips">{selectedDevices.map((device) => <span key={device.deviceId}>{deviceLabel(device)}</span>)}</div>}
              <div className="lease-list">
                {selectedDevices.map((device) => <div key={device.deviceId}><span>{deviceLabel(device)}</span><b>{device.lease ? `${device.lease.ownerName || device.lease.ownerEmail} · ${device.lease.mode}` : "空闲"}</b>{device.lease?.ownerEmail === auth.user?.email && <button onClick={() => releaseLease(device).catch((error) => setFeedback(error.message))}>释放</button>}</div>)}
                {!selectedDevices.length && <small>选择设备后显示控制者</small>}
              </div>
              <div className="lease-action-row">
                <button disabled={!primaryDevice?.online || sending} onClick={() => primaryDevice && acquireLease(primaryDevice, "manual").then(() => setFeedback(`已获取 ${deviceLabel(primaryDevice)} 控制权`)).catch((error) => setFeedback(error.message))}>获取控制权</button>
                <button className="ghost-action" disabled={!primaryDevice?.online || sending} onClick={() => primaryDevice && releaseLease(primaryDevice).then(() => setFeedback(`已释放 ${deviceLabel(primaryDevice)}`)).catch((error) => setFeedback(error.message))}>释放</button>
              </div>
            </section>

            <section className="control-section">
              <span className="sidebar-label">电池状态</span>
              <div className={`battery-status-card ${batteryTone(batteryLevel(selectedBattery))}`}>
                {selectedBattery ? <><div className="battery-status-main"><span className="battery-shell large"><i style={{ width: `${batteryLevel(selectedBattery)}%` }} /></span><b>{batteryLevel(selectedBattery)}%</b><span>{Number(selectedBattery.batteryVoltage).toFixed(2)} V</span></div><small>{selectedDevices.length > 1 ? `显示所选设备中的最低电量 · ${deviceLabel(selectedBattery)}` : deviceLabel(selectedBattery)}</small><p>{batteryLevel(selectedBattery) < 20 ? "低电量，建议尽快回收设备。" : batteryLevel(selectedBattery) < 40 ? "电量偏低，请关注剩余电量。" : "电量正常"}</p></> : <span className="battery-empty">选择设备后显示实时电池状态</span>}
              </div>
            </section>

            <section className="control-section">
              <span className="sidebar-label">参数应用方式</span>
              <div className="param-mode-grid">
                <button className={paramMode === "sync" ? "active" : ""} onClick={() => setParamMode("sync")}><strong>统一参数</strong><small>所选设备使用同一组参数</small></button>
                <button className={paramMode === "keep" ? "active" : ""} onClick={() => setParamMode("keep")}><strong>保留独立参数</strong><small>只同步动作，不覆盖参数</small></button>
              </div>
            </section>

            {paramMode === "sync" ? <section className="control-section">
              <span className="sidebar-label">统一控制参数</span>
              <label className="range-field"><span>频率 <b>{Number(frequency).toFixed(1)} Hz</b></span><input type="range" min="0.3" max="5" step="0.1" value={frequency} disabled={sending} onChange={(event) => setFrequency(event.target.value)} onPointerUp={applyParameters} onKeyUp={applyParameters} /></label>
              <label className="range-field"><span>幅度 <b>{amplitude}%</b></span><input type="range" min="0" max="100" step="1" value={amplitude} disabled={sending} onChange={(event) => setAmplitude(event.target.value)} onPointerUp={applyParameters} onKeyUp={applyParameters} /></label>
              <label className="range-field"><span>偏置 <b>{Number(bias) > 0 ? "+" : ""}{bias}°</b></span><input type="range" min="-45" max="45" step="1" value={bias} disabled={sending} onChange={(event) => setBias(event.target.value)} onPointerUp={applyParameters} onKeyUp={applyParameters} /></label>
            </section> : <section className="control-section">
              <span className="sidebar-label">当前独立参数</span>
              <div className="individual-params">{selectedDevices.map((device) => <div key={device.deviceId}><strong>{deviceLabel(device)}</strong><span>{device.frequency ?? "—"} Hz · {device.amplitude ?? "—"}° · {device.bias ?? 0}°</span></div>)}{!selectedDevices.length && <small>选择设备后显示各自参数</small>}</div>
            </section>}

            <section className="control-section">
              <span className="sidebar-label">动作控制</span>
              <div className="motion-grid">{ACTIONS.map(([mode, label]) => <button key={mode} className={activeMode === mode ? "active-motion" : ""} disabled={!selectedOnline.length || sending} onClick={() => sendToSelection(mode)}>{label}</button>)}</div>
              <button className="danger-outline full-stop" disabled={!selectedOnline.length || sending} onClick={() => sendToSelection("stop")}>停止所选 {selectedOnline.length ? `(${selectedOnline.length})` : ""}</button>
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

      <footer className="app-footer"><span>{page === "vision" ? "视觉：识别、跟踪、自动控制" : page === "manual" ? "手动：控制动作、运动参数" : "设置：账号、固件、设备和舵机中位"}</span><span>{page === "vision" ? `视觉目标 ${selectedOnline.length} 台` : page === "manual" ? targetTitle : `OTA 目标 ${otaSelectedDevices.length} 台`}</span></footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
