import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./maintenance.css";
import VisionPanel from "./VisionPanel.jsx";

const MODE_LABELS = {
  stop: "停止", idle: "待机", forward: "前进", left: "左转", right: "右转",
  0: "停止", 1: "待机", 2: "前进", 3: "左转", 4: "右转",
};
const ACTIONS = [["left", "左转"], ["forward", "前进"], ["right", "右转"], ["idle", "IDLE"]];

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

function App() {
  const [page, setPage] = useState("control");
  const [devices, setDevices] = useState([]);
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

  const onlineDevices = useMemo(() => devices.filter((device) => device.online), [devices]);
  const selectedDevices = useMemo(() => devices.filter((device) => selectedIds.has(device.deviceId)), [devices, selectedIds]);
  const selectedOnline = useMemo(() => selectedDevices.filter((device) => device.online), [selectedDevices]);
  const otaSelectedDevices = useMemo(() => devices.filter((device) => otaSelectedIds.has(device.deviceId) && device.online), [devices, otaSelectedIds]);
  const visibleDevices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((device) => `${deviceLabel(device)} ${device.deviceId || ""} ${device.ip || ""}`.toLowerCase().includes(needle));
  }, [devices, query]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/devices", { cache: "no-store" });
        if (!response.ok) throw new Error("控制器接口不可用");
        const data = await response.json();
        if (!active) return;
        const next = Array.isArray(data) ? data : [];
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
  }, [selectedDevices, sending]);

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
    if (!response.ok || result.sent === false) throw new Error(result.message || `${deviceLabel(device)} 发送失败`);
    return result;
  }

  async function sendToSelection(mode) {
    if (!selectedOnline.length || sending) { if (!selectedOnline.length) setFeedback("请先选择至少一台在线机器鱼"); return; }
    setSending(true);
    setFeedback(`正在向 ${selectedOnline.length} 台设备发送 ${MODE_LABELS[mode] || mode}…`);
    const shared = paramMode === "sync" ? { frequency, amplitude, bias } : null;
    const results = await Promise.allSettled(selectedOnline.map((device) => sendCommand(device, mode, shared)));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (mode === "stop") setActiveMode(""); else if (!failed) setActiveMode(mode);
    setFeedback(failed ? `已发送 ${results.length - failed}/${results.length} 台，${failed} 台失败` : `已发送：${MODE_LABELS[mode] || mode} · ${results.length} 台设备`);
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
      if (!response.ok || result.sent === false) throw new Error(result.message || "OTA 启动失败");
      return result;
    }));
    const failed = results.filter((result) => result.status === "rejected").length;
    setOtaFeedback(failed ? `OTA 已启动 ${results.length - failed}/${results.length} 台，${failed} 台失败` : `OTA 任务已发送 · ${results.length} 台`);
    setSending(false);
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
            <button className={page === "control" ? "active" : ""} onClick={() => setPage("control")}>控制台</button>
            <button className={page === "maintenance" ? "active" : ""} onClick={() => setPage("maintenance")}>OTA / 设置</button>
          </nav>
          <span className="top-metric"><b>{onlineDevices.length}</b><small>在线 / {devices.length}</small></span>
          <span className="status online"><i /> Controller</span>
          <button className="top-stop" disabled={!onlineDevices.length || sending} onClick={stopAll}>ALL STOP</button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}，正在自动重试。</div>}

      {page === "control" ? (
        <div className="workspace">
          <aside className="device-sidebar panel-surface">
            <div className="panel-heading"><div><span className="eyebrow">DEVICES</span><h2>机器鱼</h2></div><span>{onlineDevices.length}/{devices.length}</span></div>
            <div className="device-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称 / ID / IP" aria-label="搜索机器鱼" /></div>
            <div className="device-list">
              {visibleDevices.map((device) => {
                const selected = selectedIds.has(device.deviceId);
                return <button key={device.deviceId} className={`device-row ${selected ? "selected" : ""}`} disabled={!device.online} onClick={() => toggleSet(setSelectedIds, device.deviceId)}>
                  <span className="device-check">{selected ? "✓" : ""}</span>
                  <span className="device-main"><strong>{deviceLabel(device)}</strong><small>{MODE_LABELS[device.mode] || "未知"} · {device.frequency ?? "—"} Hz</small></span>
                  <span className={`signal ${device.online ? "online" : ""}`} />
                </button>;
              })}
              {!visibleDevices.length && <div className="sidebar-empty">{devices.length ? "没有匹配的设备" : "等待设备上线…"}</div>}
            </div>
            <div className="quick-actions"><button onClick={selectOnline}>全选在线</button><button onClick={() => setSelectedIds(new Set())}>取消选择</button></div>
            <div className="sidebar-section"><span className="sidebar-label">快速分组</span><div className="group-grid"><button onClick={() => selectGroup("A")}>A 组</button><button onClick={() => selectGroup("B")}>B 组</button><button onClick={selectOnline}>全部</button></div></div>
          </aside>

          <section className="center-column"><VisionPanel /></section>

          <aside className="control-sidebar panel-surface">
            <section className="control-section target-section">
              <div className="panel-heading compact"><div><span className="eyebrow">CONTROL TARGET</span><h2>{targetTitle}</h2></div><span className={`signal ${selectedOnline.length ? "online" : ""}`} /></div>
              <div className="selected-chips">{selectedDevices.map((device) => <span key={device.deviceId}>{deviceLabel(device)}</span>)}</div>
              <button className="danger-outline full-stop" disabled={!selectedOnline.length || sending} onClick={() => sendToSelection("stop")}>停止所选 {selectedOnline.length ? `(${selectedOnline.length})` : ""}</button>
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
              <label className="range-field"><span>频率 <b>{Number(frequency).toFixed(1)} Hz</b></span><input type="range" min="0.3" max="5" step="0.1" value={frequency} onChange={(event) => setFrequency(event.target.value)} /></label>
              <label className="range-field"><span>幅度 <b>{amplitude}°</b></span><input type="range" min="0" max="50" step="1" value={amplitude} onChange={(event) => setAmplitude(event.target.value)} /></label>
              <label className="range-field"><span>偏置 <b>{Number(bias) > 0 ? "+" : ""}{bias}°</b></span><input type="range" min="-45" max="45" step="1" value={bias} onChange={(event) => setBias(event.target.value)} /></label>
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
                <dt>当前模式</dt><dd>{MODE_LABELS[device.mode] || "未知"}</dd>
                <dt>最后在线</dt><dd>{formatTime(device.lastSeen)}</dd>
                <dt>停止原因</dt><dd>{device.stopReason || "无"}</dd>
              </dl>
            </article>)}</div>
          </aside>
        </div>
      )}

      <footer className="app-footer"><span>{page === "control" ? "页面 1 / 控制台：视觉与运动控制" : "页面 2 / OTA·设置：固件维护与设备信息"}</span><span>{page === "control" ? `控制目标 ${selectedOnline.length} 台` : `OTA 目标 ${otaSelectedDevices.length} 台`}</span></footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
