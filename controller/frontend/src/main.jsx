import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./maintenance.css";
import "./rename.css";
import VisionPanel from "./VisionPanel.jsx";

const MODE_LABELS = {
  stop: "停止", idle: "待机", forward: "前进", left: "左转", right: "右转",
  0: "停止", 1: "待机", 2: "前进", 3: "左转", 4: "右转",
};
const ACTIONS = [["left", "左转"], ["forward", "前进"], ["right", "右转"], ["idle", "IDLE"]];
const ALIAS_STORAGE_KEY = "fish-controller-device-aliases-v1";
const CALIBRATION_STORAGE_KEY = "fish-controller-motion-calibration-v1";
const MODE_NAMES = { 0: "stop", 1: "idle", 2: "forward", 3: "left", 4: "right" };

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
function motionCenter(profile, mode) {
  const min = clamp(profile.servoMin, 0, 179, 20);
  const max = clamp(profile.servoMax, min + 1, 180, 160);
  const center = clamp(profile.straightCenter, min, max, 90);
  if (mode === "left") return center + (max - center) * clamp(profile.leftCenterRatio, 0, 1, 0.5);
  if (mode === "right") return center - (center - min) * clamp(profile.rightCenterRatio, 0, 1, 0.5);
  return center;
}
function motionAmplitude(profile, center, mode) {
  const min = clamp(profile.servoMin, 0, 179, 20);
  const max = clamp(profile.servoMax, min + 1, 180, 160);
  const percent = mode === "left"
    ? profile.leftAmplitudePercent
    : mode === "right"
      ? profile.rightAmplitudePercent
      : profile.forwardAmplitudePercent;
  return Math.min(center - min, max - center) * clamp(percent, 0, 1, 0.4);
}
function motionRange(profile, mode) {
  const center = motionCenter(profile, mode);
  const amplitude = motionAmplitude(profile, center, mode);
  return { center, amplitude, min: center - amplitude, max: center + amplitude };
}
function formatDeg(value, digits = 1) { return `${Number(value).toFixed(digits)}°`; }

function App() {
  const [page, setPage] = useState("visual");
  const [devices, setDevices] = useState([]);
  const [aliases, setAliases] = useState(loadAliases);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [otaSelectedIds, setOtaSelectedIds] = useState(() => new Set());
  const [query, setQuery] = useState("");
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
  const [calibrationDeviceId, setCalibrationDeviceId] = useState("");
  const [servoMin, setServoMin] = useState(20);
  const [servoMax, setServoMax] = useState(160);
  const [straightCenter, setStraightCenter] = useState(90);
  const [forwardFrequency, setForwardFrequency] = useState(2.5);
  const [forwardAmplitudePercent, setForwardAmplitudePercent] = useState(45);
  const [leftCenterRatio, setLeftCenterRatio] = useState(50);
  const [leftFrequency, setLeftFrequency] = useState(2.3);
  const [leftAmplitudePercent, setLeftAmplitudePercent] = useState(55);
  const [rightCenterRatio, setRightCenterRatio] = useState(50);
  const [rightFrequency, setRightFrequency] = useState(2.3);
  const [rightAmplitudePercent, setRightAmplitudePercent] = useState(55);
  const [transitionMs, setTransitionMs] = useState(600);
  const [calibrationFeedback, setCalibrationFeedback] = useState("选择一条在线机器鱼开始校准");
  const calibrationCenterTimer = useRef(null);

  const onlineDevices = useMemo(() => devices.filter((device) => device.online), [devices]);
  const lowBatteryCount = useMemo(() => onlineDevices.filter((device) => (batteryLevel(device) ?? 101) < 20).length, [onlineDevices]);
  const selectedDevices = useMemo(() => devices.filter((device) => selectedIds.has(device.deviceId)), [devices, selectedIds]);
  const selectedOnline = useMemo(() => selectedDevices.filter((device) => device.online), [selectedDevices]);
  const parameterSelectionKey = useMemo(() => selectedDevices.map((device) => device.deviceId).sort().join("|"), [selectedDevices]);
  const otaSelectedDevices = useMemo(() => devices.filter((device) => otaSelectedIds.has(device.deviceId) && device.online), [devices, otaSelectedIds]);
  const visibleDevices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((device) => `${deviceLabel(device)} ${device.deviceId || ""} ${device.ip || ""}`.toLowerCase().includes(needle));
  }, [devices, query]);
  const selectedBattery = useMemo(() => {
    const measured = selectedDevices.filter((device) => batteryLevel(device) != null);
    if (!measured.length) return null;
    return measured.reduce((lowest, device) => batteryLevel(device) < batteryLevel(lowest) ? device : lowest);
  }, [selectedDevices]);
  const calibrationDevice = useMemo(() => devices.find((device) => device.deviceId === calibrationDeviceId) || null, [devices, calibrationDeviceId]);
  const calibrationProfileDraft = useMemo(() => ({
    servoMin: Number(servoMin),
    servoMax: Number(servoMax),
    straightCenter: Number(straightCenter),
    forwardFrequency: Number(forwardFrequency),
    forwardAmplitudePercent: Number(forwardAmplitudePercent) / 100,
    leftCenterRatio: Number(leftCenterRatio) / 100,
    leftFrequency: Number(leftFrequency),
    leftAmplitudePercent: Number(leftAmplitudePercent) / 100,
    rightCenterRatio: Number(rightCenterRatio) / 100,
    rightFrequency: Number(rightFrequency),
    rightAmplitudePercent: Number(rightAmplitudePercent) / 100,
    transitionMs: Number(transitionMs),
  }), [servoMin, servoMax, straightCenter, forwardFrequency, forwardAmplitudePercent, leftCenterRatio, leftFrequency, leftAmplitudePercent, rightCenterRatio, rightFrequency, rightAmplitudePercent, transitionMs]);
  const forwardRange = useMemo(() => motionRange(calibrationProfileDraft, "forward"), [calibrationProfileDraft]);
  const leftRange = useMemo(() => motionRange(calibrationProfileDraft, "left"), [calibrationProfileDraft]);
  const rightRange = useMemo(() => motionRange(calibrationProfileDraft, "right"), [calibrationProfileDraft]);

  useEffect(() => {
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
  }, [aliases]);

  useEffect(() => {
    fetch("/api/motion-calibrations", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取标定参数")))
      .then((profiles) => setCalibrationProfiles(profiles && typeof profiles === "object" ? profiles : {}))
      .catch(() => { /* retain local fallback for older controllers */ });
    return () => window.clearTimeout(calibrationCenterTimer.current);
  }, []);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (selectedDevices.length !== 1 || sending) return;
    const [device] = selectedDevices;
    setFrequency(device.frequency ?? 2.5);
    setAmplitude(device.amplitude ?? 28);
    setBias(device.bias ?? 0);
  }, [parameterSelectionKey]);

  useEffect(() => {
    if (!calibrationDevice) return;
    const saved = calibrationProfiles[calibrationDevice.deviceId];
    const center = saved?.straightCenter ?? saved?.centerDeg ?? saved?.center ?? 90 + Number(calibrationDevice.bias ?? 0);
    const forwardAmp = saved?.forwardAmplitudePercent ?? (saved?.amplitude ? saved.amplitude / 70 : 0.45);
    setServoMin(saved?.servoMin ?? 20);
    setServoMax(saved?.servoMax ?? 160);
    setStraightCenter(center);
    setForwardFrequency(saved?.forwardFrequency ?? saved?.frequency ?? Number(calibrationDevice.frequency ?? 2.5));
    setForwardAmplitudePercent(Math.round(clamp(forwardAmp, 0, 1, 0.45) * 100));
    setLeftCenterRatio(Math.round(clamp(saved?.leftCenterRatio, 0, 1, 0.5) * 100));
    setLeftFrequency(saved?.leftFrequency ?? saved?.frequency ?? 2.3);
    setLeftAmplitudePercent(Math.round(clamp(saved?.leftAmplitudePercent, 0, 1, 0.55) * 100));
    setRightCenterRatio(Math.round(clamp(saved?.rightCenterRatio, 0, 1, 0.5) * 100));
    setRightFrequency(saved?.rightFrequency ?? saved?.frequency ?? 2.3);
    setRightAmplitudePercent(Math.round(clamp(saved?.rightAmplitudePercent, 0, 1, 0.55) * 100));
    setTransitionMs(saved?.transitionMs ?? 600);
    setCalibrationFeedback(saved ? `已载入 ${deviceLabel(calibrationDevice)} 的标定参数` : "请先确认直行中心，再测试前进和转向");
  }, [calibrationDeviceId]);

  function toggleSet(setter, deviceId) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) next.delete(deviceId); else next.add(deviceId);
      return next;
    });
  }
  function selectOnline() { setSelectedIds(new Set(onlineDevices.map((device) => device.deviceId))); }
  function selectOtaOnline() { setOtaSelectedIds(new Set(onlineDevices.map((device) => device.deviceId))); }
  function selectGroup(groupName) {
    const matches = onlineDevices.filter((device) => (device.group || device.groupName || device.tags?.group) === groupName);
    if (!matches.length) { setFeedback(`当前没有在线的 ${groupName} 组设备`); return; }
    setSelectedIds(new Set(matches.map((device) => device.deviceId)));
  }

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

  async function sendCommand(device, mode, override = null) {
    const params = override || { frequency: device.frequency ?? 2.5, amplitude: device.amplitude ?? 28, bias: device.bias ?? 0 };
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: device.deviceId, mode,
        frequency: clamp(params.frequency, 0.3, 5, 2.5),
        amplitude: clamp(params.amplitude, 0, 50, 28),
        bias: clamp(params.bias, -45, 45, 0),
      }),
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
    const params = { frequency, amplitude, bias };
    const results = await Promise.allSettled(selectedOnline.map((device) => sendCommand(device, activeMode || MODE_NAMES[device.mode] || "stop", params)));
    const failed = results.filter((result) => result.status === "rejected");
    setFeedback(failed.length
      ? `开发板确认 ${results.length - failed.length}/${results.length} 台：${failed[0].reason?.message || "部分设备失败"}`
      : `开发板已确认应用：${Number(frequency).toFixed(1)} Hz · ${amplitude}° · ${Number(bias) > 0 ? "+" : ""}${bias}°`);
    setSending(false);
  }

  async function sendToSelection(mode) {
    if (!selectedOnline.length || sending) { if (!selectedOnline.length) setFeedback("请先选择至少一台在线机器鱼"); return; }
    setSending(true);
    setFeedback(`正在向 ${selectedOnline.length} 台设备发送 ${MODE_LABELS[mode] || mode}…`);
    const shared = paramMode === "sync" ? { frequency, amplitude, bias } : null;
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
    const results = await Promise.allSettled(onlineDevices.map((device) => sendCommand(device, "stop")));
    const failed = results.filter((result) => result.status === "rejected").length;
    setActiveMode("");
    setFeedback(failed ? `ALL STOP 完成，${failed} 台未确认` : `ALL STOP 完成 · ${results.length} 台`);
    setSending(false);
  }

  async function runCalibrationMotion(mode) {
    if (!calibrationDevice?.online || sending) {
      setCalibrationFeedback("请选择一条在线机器鱼");
      return;
    }
    setSending(true);
    setCalibrationFeedback(`正在发送${MODE_LABELS[mode] || mode}，等待设备 ACK…`);
    try {
      const range = motionRange(calibrationProfileDraft, mode);
      const modeFrequency = mode === "left" ? leftFrequency : mode === "right" ? rightFrequency : forwardFrequency;
      const result = await sendCommand(calibrationDevice, mode, {
        frequency: mode === "stop" ? forwardFrequency : modeFrequency,
        amplitude: mode === "stop" ? 0 : range.amplitude,
        bias: clamp((mode === "stop" ? Number(straightCenter) : range.center) - 90, -45, 45, 0),
      });
      setCalibrationFeedback(`设备已确认：${MODE_LABELS[mode] || mode} · 中心 ${formatDeg(mode === "stop" ? straightCenter : range.center)} · 摆幅 ${formatDeg(mode === "stop" ? 0 : range.amplitude)}`);
    } catch (motionError) {
      setCalibrationFeedback(`测试失败：${motionError.message}`);
    } finally {
      setSending(false);
    }
  }

  async function previewCalibrationCenter(mode = "forward", overrides = {}) {
    if (!calibrationDevice?.online) return;
    const target = motionCenter({ ...calibrationProfileDraft, ...overrides }, mode);
    window.clearTimeout(calibrationCenterTimer.current);
    calibrationCenterTimer.current = window.setTimeout(async () => {
      try {
        const result = await sendCommand(calibrationDevice, "center", { frequency: forwardFrequency, amplitude: 0, bias: target - 90 });
        setCalibrationFeedback(`${mode === "left" ? "左转中心" : mode === "right" ? "右转中心" : "直行中心"}已静态预览：${formatDeg(target)} · 设备 bias ${Number(result.applied?.bias ?? target - 90).toFixed(1)}°`);
      } catch (centerError) { setCalibrationFeedback(`中心应用失败：${centerError.message}`); }
    }, 140);
  }

  async function saveCalibrationProfile() {
    if (!calibrationDevice) return;
    const profile = {
        deviceId: calibrationDevice.deviceId,
        ...calibrationProfileDraft,
    };
    try {
      const response = await fetch("/api/motion-calibrations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      if (!response.ok) throw new Error((await response.text()).trim() || "保存失败");
      const saved = await response.json();
      const next = { ...calibrationProfiles, [calibrationDevice.deviceId]: saved };
      localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(next));
      setCalibrationProfiles(next);
      setCalibrationFeedback(`${deviceLabel(calibrationDevice)} 的独立标定参数已保存到 Controller`);
    } catch (saveError) { setCalibrationFeedback(`保存失败：${saveError.message}`); }
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

  return (
    <main className="app-shell two-page-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">F</div>
          <div><span className="eyebrow">FISH CONTROL CENTER</span><h1>多机器鱼视觉中央控制台</h1></div>
        </div>
        <div className="system-status">
          <nav className="page-tabs" aria-label="页面切换">
            <button className={page === "visual" ? "active" : ""} onClick={() => setPage("visual")}>视觉控制</button>
            <button className={page === "calibration" ? "active" : ""} onClick={() => setPage("calibration")}>手动控制与校准</button>
            <button className={page === "maintenance" ? "active" : ""} onClick={() => setPage("maintenance")}>OTA / 设置</button>
          </nav>
          <span className="top-metric"><b>{onlineDevices.length}</b><small>在线 / {devices.length}</small></span>
          <span className={`top-metric battery-metric ${lowBatteryCount ? "critical" : ""}`}><b>{lowBatteryCount}</b><small>低电量</small></span>
          <span className="status online"><i /> Controller</span>
          <button className="top-stop" disabled={!onlineDevices.length || sending} onClick={stopAll}>ALL STOP</button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}，正在自动重试。</div>}

      {page === "visual" ? (
        <div className="workspace">
          <aside className="device-sidebar panel-surface">
            <div className="panel-heading"><div><span className="eyebrow">DEVICES</span><h2>机器鱼</h2></div><span>{onlineDevices.length}/{devices.length}</span></div>
            <div className="device-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称 / ID / IP" aria-label="搜索机器鱼" /></div>
            <div className="device-list">
              {visibleDevices.map((device) => {
                const selected = selectedIds.has(device.deviceId);
                const percent = batteryLevel(device);
                const tone = batteryTone(percent);
                return <button key={device.deviceId} className={`device-row ${selected ? "selected" : ""} battery-${tone}`} disabled={!device.online} onClick={() => toggleSet(setSelectedIds, device.deviceId)}>
                  <span className="device-check">{selected ? "✓" : ""}</span>
                  <span className="device-main"><strong>{deviceLabel(device)}</strong><small>{MODE_LABELS[device.mode] || "未知"} · {device.frequency ?? "—"} Hz</small></span>
                  <span className="device-battery"><span className="battery-shell"><i style={{ width: `${percent ?? 0}%` }} /></span><b>{percent == null ? "—" : `${percent}%`}</b></span>
                </button>;
              })}
              {!visibleDevices.length && <div className="sidebar-empty">{devices.length ? "没有匹配的设备" : "等待设备上线…"}</div>}
            </div>
            <div className="quick-actions"><button onClick={selectOnline}>全选在线</button><button onClick={() => setSelectedIds(new Set())}>取消选择</button></div>
            <div className="sidebar-section"><span className="sidebar-label">快速分组</span><div className="group-grid"><button onClick={() => selectGroup("A")}>A 组</button><button onClick={() => selectGroup("B")}>B 组</button><button onClick={selectOnline}>全部</button></div></div>
          </aside>

          <section className="center-column"><VisionPanel devices={devices} targetDeviceId={visionDeviceId} onTargetDeviceChange={setVisionDeviceId} /></section>

          <aside className="control-sidebar panel-surface">
            <section className="control-section target-section">
              <div className="panel-heading compact"><div><span className="eyebrow">CONTROL TARGET</span><h2>{targetTitle}</h2></div><span className={`signal ${selectedOnline.length ? "online" : ""}`} /></div>
              <div className="selected-chips">{selectedDevices.map((device) => <span key={device.deviceId}>{deviceLabel(device)}</span>)}</div>
              <button className="danger-outline full-stop" disabled={!selectedOnline.length || sending} onClick={() => sendToSelection("stop")}>停止所选 {selectedOnline.length ? `(${selectedOnline.length})` : ""}</button>
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
              <label className="range-field"><span>幅度 <b>{amplitude}°</b></span><input type="range" min="0" max="50" step="1" value={amplitude} disabled={sending} onChange={(event) => setAmplitude(event.target.value)} onPointerUp={applyParameters} onKeyUp={applyParameters} /></label>
              <label className="range-field"><span>偏置 <b>{Number(bias) > 0 ? "+" : ""}{bias}°</b></span><input type="range" min="-45" max="45" step="1" value={bias} disabled={sending} onChange={(event) => setBias(event.target.value)} onPointerUp={applyParameters} onKeyUp={applyParameters} /></label>
            </section> : <section className="control-section">
              <span className="sidebar-label">当前独立参数</span>
              <div className="individual-params">{selectedDevices.map((device) => <div key={device.deviceId}><strong>{deviceLabel(device)}</strong><span>{device.frequency ?? "—"} Hz · {device.amplitude ?? "—"}° · {device.bias ?? 0}°</span></div>)}{!selectedDevices.length && <small>选择设备后显示各自参数</small>}</div>
            </section>}

            <section className="control-section">
              <span className="sidebar-label">动作控制</span>
              <div className="motion-grid">{ACTIONS.map(([mode, label]) => <button key={mode} className={activeMode === mode ? "active-motion" : ""} disabled={!selectedOnline.length || sending} onClick={() => sendToSelection(mode)}>{label}</button>)}</div>
              <p className="feedback" aria-live="polite">{feedback}</p>
            </section>
          </aside>
        </div>
      ) : page === "calibration" ? (
        <div className="calibration-page">
          <aside className="panel-surface calibration-devices">
            <div className="panel-heading"><div><span className="eyebrow">SELECT FISH</span><h2>选择机器鱼</h2></div><span>单鱼校准</span></div>
            <div className="device-list">
              {devices.map((device) => <button key={device.deviceId} className={`device-row ${calibrationDeviceId === device.deviceId ? "selected" : ""}`} disabled={!device.online} onClick={() => setCalibrationDeviceId(device.deviceId)}>
                <span className="device-check">{calibrationDeviceId === device.deviceId ? "✓" : ""}</span>
                <span className="device-main"><strong>{deviceLabel(device)}</strong><small>{device.deviceId} · {device.online ? "在线" : "离线"}</small></span>
                <span className={`signal ${device.online ? "online" : ""}`} />
              </button>)}
              {!devices.length && <div className="sidebar-empty">等待设备上线…</div>}
            </div>
          </aside>

          <section className="calibration-center">
            <section className="panel-surface calibration-flow-card">
              <div className="panel-heading"><div><span className="eyebrow">CALIBRATION FLOW</span><h2>设备运动校准流程</h2></div><span>每个 MAC 独立保存</span></div>
              <div className="calibration-flow"><div><b>1</b><span><strong>直行中心</strong><small>修正机械安装偏差</small></span></div><div><b>2</b><span><strong>测试动作</strong><small>确认前进和左右转</small></span></div><div><b>3</b><span><strong>保存参数</strong><small>供手动与视觉控制使用</small></span></div></div>
            </section>

            <section className="panel-surface calibration-workbench">
              <div className="panel-heading"><div><span className="eyebrow">MOTION CALIBRATION</span><h2>{calibrationDevice ? deviceLabel(calibrationDevice) : "尚未选择设备"}</h2></div><span>{calibrationDevice?.deviceId || "MAC 唯一身份"}</span></div>
              <div className="calibration-fields">
                <div className="servo-geometry-grid">
                  <label className="range-field"><span>安全最小角 <b>{servoMin}°</b></span><input type="range" min="0" max="100" step="1" value={servoMin} disabled={!calibrationDevice || sending} onChange={(event) => setServoMin(event.target.value)} /></label>
                  <label className="range-field"><span>安全最大角 <b>{servoMax}°</b></span><input type="range" min="80" max="180" step="1" value={servoMax} disabled={!calibrationDevice || sending} onChange={(event) => setServoMax(event.target.value)} /></label>
                  <label className="range-field"><span>直行中心 <b>{straightCenter}°</b></span><input type="range" min={servoMin} max={servoMax} step="1" value={straightCenter} disabled={!calibrationDevice || sending} onChange={(event) => { setStraightCenter(event.target.value); previewCalibrationCenter("forward", { straightCenter: Number(event.target.value) }); }} /><small>停止和前进都会以这个角度作为鱼尾中心</small></label>
                  <label className="range-field"><span>过渡时间 <b>{transitionMs} ms</b></span><input type="range" min="100" max="1500" step="50" value={transitionMs} disabled={!calibrationDevice || sending} onChange={(event) => setTransitionMs(event.target.value)} /><small>用于中心预览、前进/转向/停止之间的平滑切换</small></label>
                </div>
                <div className="motion-model-grid">
                  <section>
                    <header><strong>前进</strong><b>中心 {formatDeg(forwardRange.center)}</b></header>
                    <label>频率 <input type="number" min="0.3" max="5" step="0.1" value={forwardFrequency} onChange={(event) => setForwardFrequency(event.target.value)} /> Hz</label>
                    <label>摆幅 <input type="range" min="0" max="100" step="5" value={forwardAmplitudePercent} disabled={!calibrationDevice || sending} onChange={(event) => setForwardAmplitudePercent(event.target.value)} /> <span>{forwardAmplitudePercent}%</span></label>
                    <small>实际摆幅 {formatDeg(forwardRange.amplitude)} · 范围 {formatDeg(forwardRange.min)} ~ {formatDeg(forwardRange.max)}</small>
                  </section>
                  <section>
                    <header><strong>左转</strong><b>中心 {formatDeg(leftRange.center)}</b></header>
                    <label>中心比例 <input type="range" min="0" max="100" step="5" value={leftCenterRatio} disabled={!calibrationDevice || sending} onChange={(event) => { setLeftCenterRatio(event.target.value); previewCalibrationCenter("left", { leftCenterRatio: Number(event.target.value) / 100 }); }} /> <span>{leftCenterRatio}%</span></label>
                    <label>频率 <input type="number" min="0.3" max="5" step="0.1" value={leftFrequency} onChange={(event) => setLeftFrequency(event.target.value)} /> Hz</label>
                    <label>摆幅 <input type="range" min="0" max="100" step="5" value={leftAmplitudePercent} disabled={!calibrationDevice || sending} onChange={(event) => setLeftAmplitudePercent(event.target.value)} /> <span>{leftAmplitudePercent}%</span></label>
                    <small>实际摆幅 {formatDeg(leftRange.amplitude)} · 范围 {formatDeg(leftRange.min)} ~ {formatDeg(leftRange.max)}</small>
                  </section>
                  <section>
                    <header><strong>右转</strong><b>中心 {formatDeg(rightRange.center)}</b></header>
                    <label>中心比例 <input type="range" min="0" max="100" step="5" value={rightCenterRatio} disabled={!calibrationDevice || sending} onChange={(event) => { setRightCenterRatio(event.target.value); previewCalibrationCenter("right", { rightCenterRatio: Number(event.target.value) / 100 }); }} /> <span>{rightCenterRatio}%</span></label>
                    <label>频率 <input type="number" min="0.3" max="5" step="0.1" value={rightFrequency} onChange={(event) => setRightFrequency(event.target.value)} /> Hz</label>
                    <label>摆幅 <input type="range" min="0" max="100" step="5" value={rightAmplitudePercent} disabled={!calibrationDevice || sending} onChange={(event) => setRightAmplitudePercent(event.target.value)} /> <span>{rightAmplitudePercent}%</span></label>
                    <small>实际摆幅 {formatDeg(rightRange.amplitude)} · 范围 {formatDeg(rightRange.min)} ~ {formatDeg(rightRange.max)}</small>
                  </section>
                </div>
              </div>
              <div className="calibration-preview-grid">
                <button disabled={!calibrationDevice?.online || sending} onClick={() => previewCalibrationCenter("forward")}>预览直行中心<small>{formatDeg(forwardRange.center)}</small></button>
                <button disabled={!calibrationDevice?.online || sending} onClick={() => previewCalibrationCenter("left")}>预览左转中心<small>{formatDeg(leftRange.center)}</small></button>
                <button disabled={!calibrationDevice?.online || sending} onClick={() => previewCalibrationCenter("right")}>预览右转中心<small>{formatDeg(rightRange.center)}</small></button>
              </div>
              <div className="calibration-motion-grid">
                <button disabled={!calibrationDevice?.online || sending} onClick={() => runCalibrationMotion("forward")}>前进测试<small>使用当前中心</small></button>
                <button disabled={!calibrationDevice?.online || sending} onClick={() => runCalibrationMotion("left")}>左转测试<small>验证方向</small></button>
                <button disabled={!calibrationDevice?.online || sending} onClick={() => runCalibrationMotion("right")}>右转测试<small>验证方向</small></button>
                <button className="danger" disabled={!calibrationDevice?.online || sending} onClick={() => runCalibrationMotion("stop")}>立即停止<small>等待设备 ACK</small></button>
              </div>
              <p className="feedback calibration-feedback" aria-live="polite">{calibrationFeedback}</p>
            </section>
          </section>

          <aside className="panel-surface calibration-summary">
            <div className="panel-heading"><div><span className="eyebrow">PROFILE</span><h2>当前设备参数</h2></div><span>{calibrationProfiles[calibrationDeviceId] ? "已保存" : "未保存"}</span></div>
            <dl><dt>设备</dt><dd>{calibrationDevice ? deviceLabel(calibrationDevice) : "—"}</dd><dt>MAC / ID</dt><dd>{calibrationDevice?.deviceId || "—"}</dd><dt>安全范围</dt><dd>{servoMin}° ~ {servoMax}°</dd><dt>直行中心</dt><dd>{formatDeg(forwardRange.center, 0)}</dd><dt>过渡时间</dt><dd>{transitionMs} ms</dd><dt>前进范围</dt><dd>{formatDeg(forwardRange.min)} ~ {formatDeg(forwardRange.max)}</dd><dt>左转中心</dt><dd>{formatDeg(leftRange.center)}</dd><dt>左转范围</dt><dd>{formatDeg(leftRange.min)} ~ {formatDeg(leftRange.max)}</dd><dt>右转中心</dt><dd>{formatDeg(rightRange.center)}</dd><dt>右转范围</dt><dd>{formatDeg(rightRange.min)} ~ {formatDeg(rightRange.max)}</dd></dl>
            <button className="calibration-save" disabled={!calibrationDevice} onClick={saveCalibrationProfile}>保存独立标定参数</button>
            <button className="danger-outline calibration-stop" disabled={!calibrationDevice?.online || sending} onClick={() => runCalibrationMotion("stop")}>立即停止</button>
            <p className="calibration-note">GUI 使用新舵机模型计算中心和摆幅，再兼容下发当前固件可识别的 motion.set / CENTER。下一步需要让固件原生支持过渡时间和停止回直行中心。</p>
          </aside>
        </div>
      ) : (
        <div className="maintenance-page">
          <section className="panel-surface ota-workspace">
            <div className="panel-heading"><div><span className="eyebrow">OTA</span><h2>固件升级</h2></div><span className={`firmware-ready ${firmwareInfo.available ? "ready" : ""}`}>{firmwareInfo.available ? "READY" : "NO FIRMWARE"}</span></div>
            <div className="ota-content">
              <div className="ota-steps"><div><b>1</b><span>选择电脑 BIN</span></div><div><b>2</b><span>上传并校验</span></div><div><b>3</b><span>选择升级设备</span></div><div><b>4</b><span>开始 OTA</span></div></div>
              <label className="local-bin-picker"><input type="file" accept=".bin,application/octet-stream" onChange={(event) => { setFirmwareFile(event.target.files?.[0] || null); setOtaFeedback("文件已选择，等待上传"); }} /><strong>{firmwareFile ? firmwareFile.name : "选择电脑上的 firmware.bin"}</strong><small>点击这里打开系统文件选择窗口</small></label>
              {firmwareFile && <div className="local-file-meta"><span>本地文件</span><b>{firmwareFile.name}</b><span>大小</span><b>{formatBytes(firmwareFile.size)}</b></div>}
              <button className="upload-button" disabled={!firmwareFile || uploading} onClick={uploadFirmware}>{uploading ? "上传校验中…" : "上传到控制器并校验"}</button>
              {firmwareInfo.available && <div className="firmware-meta"><div><span>当前固件</span><b>{firmwareInfo.name}</b></div><div><span>大小</span><b>{formatBytes(firmwareInfo.size)}</b></div><div className="hash"><span>SHA-256</span><code>{firmwareInfo.sha256}</code></div></div>}

              <div className="ota-target-header"><div><span className="sidebar-label no-pad">升级目标</span><small>已选择 {otaSelectedDevices.length} 台</small></div><div><button onClick={selectOtaOnline}>全选在线</button><button onClick={() => setOtaSelectedIds(new Set())}>取消选择</button></div></div>
              <div className="ota-device-grid">{devices.map((device) => {
                const selected = otaSelectedIds.has(device.deviceId);
                return <button key={device.deviceId} className={`ota-device-card ${selected ? "selected" : ""}`} disabled={!device.online} onClick={() => toggleSet(setOtaSelectedIds, device.deviceId)}>
                  <span className="device-check">{selected ? "✓" : ""}</span><span><strong>{deviceLabel(device)}</strong><small>{device.deviceId}</small></span><em>{device.online ? "在线" : "离线"}</em>
                </button>;
              })}</div>
              <button className="ota-start large" disabled={!firmwareInfo.available || !otaSelectedDevices.length || sending || uploading} onClick={startOta}>开始升级所选设备 {otaSelectedDevices.length ? `(${otaSelectedDevices.length})` : ""}</button>
              <p className="feedback" aria-live="polite">{otaFeedback}</p>
            </div>
          </section>

          <aside className="panel-surface device-info-panel">
            <div className="panel-heading"><div><span className="eyebrow">DEVICE SETTINGS</span><h2>设备信息 / 设置</h2></div><span>{devices.length} 台</span></div>
            <div className="device-info-list">{devices.map((device) => <article className="device-info-card" key={device.deviceId}>
              <header><strong>{deviceLabel(device)}</strong><span className={device.online ? "online-text" : "offline-text"}>{device.online ? "● 在线" : "○ 离线"}</span></header>
              <dl>
                <dt>MAC 地址</dt><dd>{device.mac || device.deviceId || "—"}</dd>
                <dt>设备 ID</dt><dd>{device.deviceId || "—"}</dd>
                <dt>IP 地址</dt><dd>{device.ip || "—"}</dd>
                <dt>固件版本</dt><dd>{device.firmwareVersion || "—"}</dd>
                <dt>RSSI</dt><dd>{device.online && device.rssi ? `${device.rssi} dBm` : "—"}</dd>
                <dt>电池电量</dt><dd>{device.online && Number.isFinite(device.batteryVoltage) && device.batteryVoltage > 0 ? `${device.batteryPercent}% · ${device.batteryVoltage.toFixed(2)} V` : "—"}</dd>
                <dt>环境照度</dt><dd>{device.lightSensorOnline ? `${Number(device.illuminanceLux).toFixed(2)} lux` : `未检测到${device.i2cAddresses?.length ? ` · I²C ${device.i2cAddresses.map((address) => `0x${Number(address).toString(16).toUpperCase()}`).join(", ")}` : ""}`}</dd>
                <dt>RGB 模式</dt><dd>{device.rgbMode || "AUTO"} · {device.rgbOrder || "GRB"}</dd>
                <dt>当前模式</dt><dd>{MODE_LABELS[device.mode] || "未知"}</dd>
                <dt>最后在线</dt><dd>{formatTime(device.lastSeen)}</dd>
                <dt>停止原因</dt><dd>{device.stopReason || "无"}</dd>
              </dl>
              <div className="rgb-controls"><label><span>RGB 颜色</span><input type="color" value={rgbColor} onChange={(event) => setRgbColor(event.target.value)} /></label><label><span>灯珠色序</span><select value={rgbOrder} onChange={(event) => setRgbOrder(event.target.value)}>{["RGB","GRB","RBG","GBR","BRG","BGR"].map((order) => <option key={order}>{order}</option>)}</select></label><label><span>亮度 {rgbBrightness}</span><input type="range" min="1" max="255" value={rgbBrightness} onChange={(event) => setRgbBrightness(event.target.value)} onPointerUp={() => setRgb(device, device.rgbMode === "SOLID" ? "SOLID" : "AUTO")} onKeyUp={() => setRgb(device, device.rgbMode === "SOLID" ? "SOLID" : "AUTO")} /></label><small>松开滑块后立即下发，并等待开发板确认。</small><div><button type="button" disabled={!device.online} onClick={() => setRgb(device,"SOLID")}>应用颜色</button><button type="button" disabled={!device.online} onClick={() => setRgb(device,"AUTO")}>自动模式</button></div></div>
              <div className="device-card-actions"><button type="button" onClick={() => openRename(device)}>✎ 重命名设备</button></div>
            </article>)}</div>
          </aside>
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

      <footer className="app-footer"><span>{page === "visual" ? "视觉控制：识别、方向确认、绘制轨迹与循迹" : page === "calibration" ? "手动控制与校准：每条机器鱼独立参数" : "OTA / 设置：固件维护与设备信息"}</span><span>{page === "visual" ? `控制目标 ${selectedOnline.length} 台` : page === "calibration" ? (calibrationDevice ? deviceLabel(calibrationDevice) : "未选择设备") : `OTA 目标 ${otaSelectedDevices.length} 台`}</span></footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
