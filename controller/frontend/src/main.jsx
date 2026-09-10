import { createMultiKeyboard, DEFAULT_KEYS } from "./multiKeyboard.js";
import { Component, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./maintenance.css";
import "./rename.css";
import "./console-theme.css";
import VisionPanel from "./VisionPanel.jsx";
import AuthScreen from "./components/AuthScreen.jsx";
import ManualInspector from "./components/ManualInspector.jsx";
import SettingsWorkspace from "./components/SettingsWorkspace.jsx";
import { deviceStateSignature, mergeDevicesInStableOrder } from "./deviceState.js";
import {
  batteryLevel,
  deviceLabel,
  formatBytes,
  leaseIsMine,
  CONTROL_CLIENT_ID,
  leaseSummary,
  roleLabel,
} from "./ui/devicePresentation.js";

const MODE_LABELS = {
  stop: "停止", idle: "待机", forward: "前进", left: "左转", right: "右转",
  0: "停止", 1: "待机", 2: "前进", 3: "左转", 4: "右转",
};
const ALIAS_STORAGE_KEY = "fish-controller-device-aliases-v1";
const CALIBRATION_STORAGE_KEY = "fish-controller-motion-calibration-v1";
const MANUAL_MOTION_STORAGE_KEY = "fish-controller-manual-motion-v1";
const DEFAULT_AMPLITUDE_PERCENT = 40;
const DEFAULT_FREQUENCY = 2.5;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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
function loadManualMotionProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MANUAL_MOTION_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}
function normalizeDeviceName(value) { return String(value || "").trim().toLocaleLowerCase(); }
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
function visionStateSignature(state) {
  return JSON.stringify({
    state: state?.state || "idle",
    sessionId: state?.sessionId || null,
    targetDeviceId: state?.targetDeviceId || "",
    targetTrackId: state?.targetTrackId ?? null,
    metrics: state?.metrics || {},
  });
}

function App() {
  const [auth, setAuth] = useState({ loading: true, authenticated: false, bootstrap: false, user: null });
  const multiKeyboardRef = useRef(null);
  const [keyProfiles, setKeyProfiles] = useState({});
  useEffect(() => {
    try { setKeyProfiles(JSON.parse(localStorage.getItem(`fish-keys:${auth.user?.id || "guest"}`) || "{}")); } catch { setKeyProfiles({}); }
  }, [auth.user?.id]);
  function saveKeys(deviceId, profile) {
    multiKeyboardRef.current?.stop();
    const next = { ...keyProfiles, [deviceId]: profile };
    setKeyProfiles(next);
    localStorage.setItem(`fish-keys:${auth.user?.id || "guest"}`, JSON.stringify(next));
  }
  const [page, setPage] = useState("manual");
  const [devices, setDevices] = useState([]);
  const [aliases, setAliases] = useState(loadAliases);
  const [manualMotionByDevice, setManualMotionByDevice] = useState({});
  useEffect(() => {
    try { setManualMotionByDevice(JSON.parse(localStorage.getItem(`${MANUAL_MOTION_STORAGE_KEY}:${auth.user?.id || "guest"}`) || "{}")); } catch { setManualMotionByDevice({}); }
  }, [auth.user?.id]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [otaSelectedIds, setOtaSelectedIds] = useState(() => new Set());
  const [feedback, setFeedback] = useState("等待控制指令");
  const [sending, setSending] = useState(false);
  const [manualCommandBusy, setManualCommandBusy] = useState(false);
  const [leaseBusy, setLeaseBusy] = useState(false);
  const [error, setError] = useState("");
  const [firmwareInfo, setFirmwareInfo] = useState({ available: false });
  const [firmwareFile, setFirmwareFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [otaFeedback, setOtaFeedback] = useState("请选择电脑上的 firmware.bin，并选择升级目标");
  const [renameDevice, setRenameDevice] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [rgbColor, setRgbColor] = useState("#00ff66");
  const [rgbBrightness, setRgbBrightness] = useState(32);
  const [rgbOrder, setRgbOrder] = useState("GRB");
  const [visionDeviceId, setVisionDeviceId] = useState("");
  const [visionTrackId, setVisionTrackId] = useState(null);
  const [visionState, setVisionState] = useState({ state: "idle", targetDeviceId: "", metrics: {} });
  const [keyboardStatus, setKeyboardStatus] = useState({ phase: "idle", mode: "stop", deviceId: "", message: "" });
  const [calibrationProfiles, setCalibrationProfiles] = useState(loadCalibrationProfiles);
  const keyboardRef = useRef({ sequence: 0, lastErrorAt: 0 });
  const manualControlRef = useRef(null);
  const devicesRef = useRef([]);
  const deviceSignatureRef = useRef("");
  const visionStateSignatureRef = useRef("");
  const visionSessionIdRef = useRef(null);

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
  const isAdmin = auth.user?.role === "Admin";
  const lowBatteryCount = useMemo(() => onlineDevices.filter((device) => (batteryLevel(device) ?? 101) < 20).length, [onlineDevices]);
  const selectedDevice = useMemo(() => devices.find((device) => device.deviceId === selectedDeviceId) || null, [devices, selectedDeviceId]);
  const selectedManualMotion = useMemo(() => {
    const saved = manualMotionByDevice[selectedDeviceId] || {};
    return {
      frequency: clamp(saved.frequency, 0.3, 5, DEFAULT_FREQUENCY),
      amplitudePercent: clamp(saved.amplitudePercent, 0, 100, DEFAULT_AMPLITUDE_PERCENT),
    };
  }, [manualMotionByDevice, selectedDeviceId]);
  const otaSelectedDevices = useMemo(() => devices.filter((device) => otaSelectedIds.has(device.deviceId) && device.online), [devices, otaSelectedIds]);

  useEffect(() => {
    if (keyboardStatus.phase !== "queued" || !keyboardStatus.deviceId || !keyboardStatus.mode) return;
    const device = devices.find((item) => item.deviceId === keyboardStatus.deviceId);
    if (!device) return;
    const mode = MODE_LABELS[device.mode] || "未知";
    const expected = MODE_LABELS[keyboardStatus.mode] || keyboardStatus.mode;
    if (mode !== expected) return;
    setKeyboardStatus((current) => (
      current.phase === "queued"
        ? { ...current, phase: "confirmed", message: `${expected} 已由设备状态确认` }
        : current
    ));
  }, [devices, keyboardStatus.deviceId, keyboardStatus.mode, keyboardStatus.phase]);

  manualControlRef.current = {
    page,
    authenticated: auth.authenticated,
    currentUserEmail: auth.user?.email,
    user: auth.user,
    selectedDevice,
    manualMotionByDevice,
    selectedManualMotion,
    keyProfiles,
  };

  function commitDeviceSnapshot(next, force = false) {
    const ordered = mergeDevicesInStableOrder(devicesRef.current, next);
    const nextSignature = deviceStateSignature(ordered);
    devicesRef.current = ordered;
    if (!force && nextSignature === deviceSignatureRef.current) return ordered;
    deviceSignatureRef.current = nextSignature;
    setDevices(ordered);
    return ordered;
  }

  function patchDevice(deviceId, patch) {
    if (!deviceId) return;
    commitDeviceSnapshot(devicesRef.current.map((device) => (
      device.deviceId === deviceId ? { ...device, ...patch } : device
    )));
  }

  const handleVisionStateChange = useCallback((next) => {
    const signature = visionStateSignature(next);
    if (signature !== visionStateSignatureRef.current) {
      visionStateSignatureRef.current = signature;
      setVisionState(next);
    }
    // SSE can arrive between a target change request and its response. Do not
    // let the old session snapshot overwrite the user's newer selection.
    if (next?.sessionId !== visionSessionIdRef.current) {
      visionSessionIdRef.current = next?.sessionId || null;
      if (next?.targetDeviceId !== undefined) {
        setVisionDeviceId(next.targetDeviceId || "");
      }
      if (next?.targetTrackId !== undefined) {
        setVisionTrackId(next.targetTrackId ?? null);
      }
    }
  }, []);

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
      const incoming = raw.map((device) => ({ ...device, name: aliases[device.deviceId] || device.name }));
      const previous = devicesRef.current;
      const next = mergeDevicesInStableOrder(previous, incoming);
      const nextByID = new Map(next.map((device) => [device.deviceId, device]));
      const lostControl = previous
        .filter((previousDevice) => leaseIsMine(previousDevice.lease, auth.user))
        .filter((previousDevice) => {
          const currentDevice = nextByID.get(previousDevice.deviceId);
          return !currentDevice
            || !currentDevice.online
            || !leaseIsMine(currentDevice.lease, auth.user);
        });
      commitDeviceSnapshot(next);
      setError("");
      const valid = new Set(next.map((device) => device.deviceId));
      setSelectedDeviceId((current) => (valid.has(current) ? current : ""));
      setOtaSelectedIds((current) => {
        const filtered = new Set([...current].filter((id) => valid.has(id) && nextByID.get(id)?.online));
        return sameStringSet(current, filtered) ? current : filtered;
      });
      if (lostControl.length) {

        stopKeyboardControl(lostControl);
        setFeedback(`${lostControl.map(deviceLabel).join("、")} 控制权已失效，正在停止设备`);
      }
    });
    let checkingSession = false;
    source.onerror = async () => {
      if (!active) return;
      setError("设备事件通道暂时断开，浏览器正在自动重连");
      if (checkingSession) return;
      checkingSession = true;
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const session = await response.json();
        if (active && (response.status === 401 || (response.ok && session.authenticated === false))) {
          source.close();
          setError("");
          setAuth({ loading: false, authenticated: false, bootstrap: Boolean(session.bootstrap), user: null });
        }
      } catch { /* Network failure keeps the automatic reconnect active. */ }
      finally { checkingSession = false; }
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
    if (!auth.authenticated || !isAdmin) return;
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
  }, [auth.authenticated, isAdmin]);

  function toggleSet(setter, deviceId) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) next.delete(deviceId); else next.add(deviceId);
      return next;
    });
  }
  function toggleOtaDevice(deviceId) {
    if (deviceId === "clear") {
      setOtaSelectedIds(new Set());
      return;
    }
    toggleSet(setOtaSelectedIds, deviceId);
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
    patchDevice(renameDevice.deviceId, { name: nextName });
    setFeedback(`${deviceLabel(renameDevice)} 已重命名为 ${nextName}`);
    closeRename();
  }

  async function logout() {
    await multiKeyboardRef.current?.stop();
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuth({ loading: false, authenticated: false, bootstrap: false, user: null });
    setDevices([]);
    devicesRef.current = [];
    deviceSignatureRef.current = "";
    setSelectedDeviceId("");
    setOtaSelectedIds(new Set());
  }

  async function acquireLease(device, mode = "manual", force = false) {
    if (!device?.deviceId) throw new Error("设备信息无效，请重新选择设备");
    const response = await fetch("/api/leases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, mode, force, clientId: CONTROL_CLIENT_ID }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.acquired !== true || !result.lease || typeof result.lease !== "object") {
      throw new Error(result.message || `${deviceLabel(device)} 控制权获取失败`);
    }
    const lease = result.lease;
    patchDevice(device.deviceId, { lease });
    return lease;
  }

  function selectDevice(device) {
    if (!device?.deviceId) return;
    const currentDevice = manualControlRef.current?.selectedDevice;
    if (currentDevice && currentDevice.deviceId !== device.deviceId && !manualControlRef.current.keyProfiles[currentDevice.deviceId]?.enabled) {
      multiKeyboardRef.current?.stop(currentDevice);
    }
    setSelectedDeviceId(device.deviceId);
    const lease = leaseSummary(device, auth.user);
    setFeedback(
      lease.mine
        ? `${deviceLabel(device)} 是你的当前控制设备。`
        : lease.className === "other"
          ? `${deviceLabel(device)} 当前由 ${lease.owner} 控制，只读查看。`
          : `${deviceLabel(device)} 当前空闲，请在右侧明确接管。`,
    );
  }

  useEffect(() => {
    const device = devicesRef.current.find((item) => item.deviceId === visionDeviceId);
    if (device) selectDevice(device);
    else {
      stopKeyboardControl();
      setSelectedDeviceId("");
    }
  }, [visionDeviceId]);

  async function claimDevice(device, mode = "manual") {
    if (!device?.deviceId || leaseBusy || !device.online) return false;
    setLeaseBusy(true);
    setFeedback(`正在接管 ${deviceLabel(device)}…`);
    try {
      await acquireLease(device, mode);
      setFeedback(`已接管 ${deviceLabel(device)}，可继续接管其他鱼`);
      return true;
    } catch (error) {
      setFeedback(error.message);
      return false;
    } finally {
      setLeaseBusy(false);
    }
  }

  async function releaseLease(device, force = false) {
    const response = await fetch("/api/leases", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, force: force === true, clientId: CONTROL_CLIENT_ID }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.released === false) {
      throw new Error(result.message || `${deviceLabel(device)} 控制权释放失败`);
    }
    patchDevice(device.deviceId, { lease: null });
  }

  async function releaseSelectedDevice(force = false) {
    const device = manualControlRef.current.selectedDevice;
    if (!device || leaseBusy) return;
    setLeaseBusy(true);
    setFeedback(`正在停止并释放 ${deviceLabel(device)}…`);

    try {
      await stopKeyboardControl(device, true);
      await releaseLease(device, force);
      setSelectedDeviceId("");
      setFeedback(`${deviceLabel(device)} 控制权已释放`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setLeaseBusy(false);
    }
  }

  function manualMotionForDevice(device) {
    const saved = manualMotionByDevice[device?.deviceId] || {};
    return {
      frequency: clamp(saved.frequency, 0.3, 5, DEFAULT_FREQUENCY),
      amplitudePercent: clamp(saved.amplitudePercent, 0, 100, DEFAULT_AMPLITUDE_PERCENT),
    };
  }

  function updateManualMotion(device, key, value) {
    if (!device?.deviceId) return;
    const current = manualMotionForDevice(device);
    const next = {
      ...current,
      [key]: key === "frequency"
        ? clamp(value, 0.3, 5, DEFAULT_FREQUENCY)
        : clamp(value, 0, 100, DEFAULT_AMPLITUDE_PERCENT),
    };
    setManualMotionByDevice((profiles) => {
      const updated = { ...profiles, [device.deviceId]: next };
      localStorage.setItem(`${MANUAL_MOTION_STORAGE_KEY}:${auth.user?.id || "guest"}`, JSON.stringify(updated));
      return updated;
    });

    const mode = multiKeyboardRef.current?.mode(device.deviceId);
    if (mode && mode !== "stop") sendRealtimeCommand(device, mode, undefined, next).catch(reportKeyboardError);
  }

  async function sendCommand(device, mode, override = null) {
    if (auth.authenticated && mode !== "stop") {
      const lease = device.lease;
      if (!leaseIsMine(lease, auth.user)) {
        await acquireLease(device, "manual");
      }
    }
    const params = override || { frequency: device.frequency ?? 2.5, amplitudePercent: DEFAULT_AMPLITUDE_PERCENT };
    const payload = {
      deviceId: device.deviceId, mode, clientId: CONTROL_CLIENT_ID,
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
    if (result.applied) patchDevice(device.deviceId, result.applied);
    return result;
  }

  async function sendManualMotion(mode) {
    const device = manualControlRef.current.selectedDevice;
    if (!device || manualCommandBusy || !leaseIsMine(device.lease, auth.user)) return;
    setManualCommandBusy(true);
    setFeedback(`${deviceLabel(device)}：正在等待设备确认${MODE_LABELS[mode] || mode}…`);
    try {
      await sendCommand(device, mode, selectedManualMotion);
      setFeedback(`${deviceLabel(device)}：${MODE_LABELS[mode] || mode} 已由设备确认`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setManualCommandBusy(false);
    }
  }

  async function sendRealtimeCommand(device, mode, sequence, override = null) {
    const isStop = mode === "stop";
    const savedMotion = manualControlRef.current.manualMotionByDevice?.[device.deviceId] || {};
    const motion = override || {
      frequency: clamp(savedMotion.frequency, 0.3, 5, DEFAULT_FREQUENCY),
      amplitudePercent: clamp(savedMotion.amplitudePercent, 0, 100, DEFAULT_AMPLITUDE_PERCENT),
    };
    const payload = isStop ? {
      deviceId: device.deviceId,
      clientId: CONTROL_CLIENT_ID,
      mode: "stop",
      frequency: 0.3,
      amplitudePercent: 0,
      bias: 0,
    } : {
      deviceId: device.deviceId,
      clientId: CONTROL_CLIENT_ID,
      mode,
      frequency: clamp(motion.frequency, 0.3, 5, DEFAULT_FREQUENCY),
      amplitudePercent: clamp(motion.amplitudePercent, 0, 100, DEFAULT_AMPLITUDE_PERCENT),
    };
    if (!isStop && motion.bias !== undefined && motion.bias !== null) {
      payload.bias = clamp(motion.bias, -90, 90, 0);
    }
    const nextSequence = sequence ?? (() => {
      const state = keyboardRef.current;
      state.sequence += 1;
      return state.sequence;
    })();
    payload.sequence = nextSequence;
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
    setKeyboardStatus((current) => ({ ...current, phase: "error", message: error.message }));
    setFeedback(error.message);
  }

  function stopKeyboardControl(targetDevice = null) {
    const driver = multiKeyboardRef.current;
    if (!driver) return Promise.resolve();
    return Array.isArray(targetDevice) ? Promise.all(targetDevice.map(device => driver.stop(device))) : driver.stop(targetDevice);
  }

  useEffect(() => {
    const driver = createMultiKeyboard({
      targets: () => {
        const current = manualControlRef.current;
        if (!current.authenticated || current.page !== "manual" || document.hidden) return [];
        return devicesRef.current.filter(d => d.online && leaseIsMine(d.lease, current.user))
          .filter(d => current.keyProfiles[d.deviceId]?.enabled || d.deviceId === current.selectedDevice?.deviceId)
          .map(device => ({ device, keys: current.keyProfiles[device.deviceId]?.keys || DEFAULT_KEYS }));
      },
      send: sendRealtimeCommand,
      onError: reportKeyboardError,
    });
    multiKeyboardRef.current = driver;
    function keyDown(event) {
      if (isTypingTarget(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
      if (driver.key(event.code, true)) event.preventDefault();
    }
    function keyUp(event) { if (driver.key(event.code, false)) event.preventDefault(); }
    function release() { driver.stop(); }
    function visibility() { if (document.hidden) release(); }
    let renewing = false;
    const timer = window.setInterval(async () => {
      driver.update();
      if (renewing) return;
      renewing = true;
      try {
        await Promise.all(driver.active().map(async device => {
          const response = await fetch("/api/leases", { method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: device.deviceId, clientId: CONTROL_CLIENT_ID }) });
          if (!response.ok) { await driver.stop(device); throw new Error("控制权已失效"); }
        }));
      } catch (error) { reportKeyboardError(error); }
      finally { renewing = false; }
    }, 1000);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer); release(); multiKeyboardRef.current = null;
      window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", release); document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    if (page !== "manual" || !auth.authenticated) {


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
    if (!auth.authenticated) {
      setOtaFeedback("请先登录后再保存舵机标定");
      return;
    }
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
    setUploadProgress(0);
    setOtaFeedback("正在上传并校验固件…");
    try {
      const form = new FormData();
      form.append("firmware", firmwareFile);
      const info = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/firmware");
        request.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100));
        });
        request.addEventListener("load", () => {
          const raw = request.responseText || "";
          if (request.status < 200 || request.status >= 300) {
            reject(new Error(raw.trim() || "上传失败"));
            return;
          }
          try { resolve(JSON.parse(raw)); } catch { reject(new Error("服务器返回了无效的固件信息")); }
        });
        request.addEventListener("error", () => reject(new Error("上传连接失败")));
        request.addEventListener("abort", () => reject(new Error("上传已取消")));
        request.send(form);
      });
      setFirmwareInfo(info);
      setUploadProgress(100);
      setOtaFeedback(`固件已就绪 · ${info.name} · ${formatBytes(info.size)}`);
      setFirmwareFile(null);
      return info;
    } catch (uploadError) {
      setOtaFeedback(`上传失败：${uploadError.message}`);
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function startOta() {
    if (!firmwareInfo.available && !firmwareFile) { setOtaFeedback("请先选择 firmware.bin"); return; }
    if (!otaSelectedDevices.length || sending) { setOtaFeedback("请至少选择一台在线设备作为 OTA 目标"); return; }
    const firmwareName = firmwareFile?.name || firmwareInfo.name || "当前固件";
    if (!window.confirm(`确定使用 ${firmwareName} 升级 ${otaSelectedDevices.length} 台设备？升级期间设备会停止并重启。`)) return;
    setSending(true);
    if (firmwareFile) {
      const preparedFirmware = await uploadFirmware();
      if (!preparedFirmware?.available) {
        setSending(false);
        return;
      }
    }
    setOtaFeedback(`正在向 ${otaSelectedDevices.length} 台设备创建 OTA 任务…`);
    const results = await Promise.allSettled(otaSelectedDevices.map(async (device) => {
      const response = await fetch("/api/ota", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId, name: deviceLabel(device) }) });
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
          <div><span className="eyebrow">FISH CONTROL</span><h1>多鱼控制台</h1></div>
        </div>
        <nav className="page-tabs" aria-label="页面切换">
          <button className={page === "manual" ? "active" : ""} onClick={() => setPage("manual")}>手动控制</button>
          <button className={page === "vision" ? "active" : ""} onClick={() => setPage("vision")}>视觉控制</button>
          <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>系统设置</button>
        </nav>
        <div className="system-status top-actions">
          <span className="status online"><i />服务器在线</span>
          <span className="user">{roleLabel(auth.user)} <strong>{auth.user?.name || auth.user?.email}</strong></span>
          {isAdmin && <button className="top-stop" disabled={!onlineDevices.length || sending} onClick={stopAll}>全部停止</button>}
          <button className="logout-button" onClick={logout}>退出</button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}，正在自动重试。</div>}

      {page !== "settings" ? (
        <div className={`workspace ${page}-workspace`}>
          <section className={`stage-column ${page === "vision" ? "vision-stage-column" : ""}`}>
            <VisionPanel
              isAdmin={isAdmin}
              user={auth.user}
              devices={devices}
              targetDeviceId={visionDeviceId}
              targetTrackId={visionTrackId}
              onTargetDeviceChange={setVisionDeviceId}
              onTargetTrackChange={setVisionTrackId}
              onVisionStateChange={handleVisionStateChange}
              onClaimDevice={(device) => claimDevice(device, "vision")}
              mode={page === "manual" ? "manual" : "vision"}
              showTargetDeviceSelector={true}
              showControls={page === "vision"}
            />
          </section>
          {page === "manual" && <ManualInspector
            device={selectedDevice}
            user={auth.user}
            devices={devices}
            leaseBusy={leaseBusy || manualCommandBusy}
            onClaim={() => selectedDevice && claimDevice(selectedDevice)}
            onRelease={releaseSelectedDevice}
            onMotion={sendManualMotion}
            motion={selectedManualMotion}
            onMotionChange={updateManualMotion.bind(null, selectedDevice)}
            feedback={feedback}
            keyboardStatus={keyboardStatus}
            keyProfile={keyProfiles[selectedDevice?.deviceId] || { keys: DEFAULT_KEYS, enabled: false }}
            onKeysChange={profile => selectedDevice && saveKeys(selectedDevice.deviceId, profile)}
          />}
        </div>
      ) : (
        <SettingsWorkspace
          authUser={auth.user}
          isAdmin={isAdmin}
          devices={devices}
          onlineDevices={onlineDevices}
          lowBatteryCount={lowBatteryCount}
          sending={sending}
          stopAll={stopAll}
          onLogout={logout}
          firmwareInfo={firmwareInfo}
          firmwareFile={firmwareFile}
          setFirmwareFile={(file) => {
            setFirmwareFile(file);
            setOtaFeedback(file ? "文件已选择，点击开始升级" : "请选择电脑上的 firmware.bin");
          }}
          uploading={uploading}
          uploadProgress={uploadProgress}
          startOta={startOta}
          otaFeedback={otaFeedback}
          otaSelectedDevices={otaSelectedDevices}
          otaSelectedIds={otaSelectedIds}
          selectOtaOnline={selectOtaOnline}
          toggleOtaDevice={toggleOtaDevice}
          deviceNeutralCenter={deviceNeutralCenter}
          updateLocalNeutral={updateLocalNeutral}
          saveDeviceNeutral={saveDeviceNeutral}
          rgbColor={rgbColor}
          setRgbColor={setRgbColor}
          rgbBrightness={rgbBrightness}
          setRgbBrightness={setRgbBrightness}
          rgbOrder={rgbOrder}
          setRgbOrder={setRgbOrder}
          setRgb={setRgb}
          openRename={openRename}
        />
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

const rootElement = document.getElementById("root");
if (rootElement) {
  const rootKey = "__fishControllerReactRoot";
  const root = window[rootKey] || createRoot(rootElement);
  window[rootKey] = root;
  root.render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
}
