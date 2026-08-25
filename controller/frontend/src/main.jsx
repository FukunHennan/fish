import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import VisionPanel from "./VisionPanel.jsx";

const MODE_LABELS = {
  stop: "停止",
  idle: "待机",
  forward: "前进",
  left: "左转",
  right: "右转",
  0: "停止",
  1: "待机",
  2: "前进",
  3: "左转",
  4: "右转",
};

const ACTIONS = [
  ["left", "左转"],
  ["forward", "前进"],
  ["right", "右转"],
  ["idle", "IDLE"],
];

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function deviceLabel(device) {
  return device.name || device.deviceId || "未命名机器鱼";
}

function App() {
  const [devices, setDevices] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [paramMode, setParamMode] = useState("sync");
  const [frequency, setFrequency] = useState(2.5);
  const [amplitude, setAmplitude] = useState(28);
  const [bias, setBias] = useState(0);
  const [feedback, setFeedback] = useState("等待控制指令");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const onlineDevices = useMemo(() => devices.filter((device) => device.online), [devices]);
  const selectedDevices = useMemo(
    () => devices.filter((device) => selectedIds.has(device.deviceId)),
    [devices, selectedIds],
  );
  const selectedOnline = useMemo(() => selectedDevices.filter((device) => device.online), [selectedDevices]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/devices", { cache: "no-store" });
        if (!response.ok) throw new Error("控制器接口不可用");
        const data = await response.json();
        if (!active) return;
        setDevices(Array.isArray(data) ? data : []);
        setError("");
        setSelectedIds((current) => {
          const valid = new Set((Array.isArray(data) ? data : []).map((device) => device.deviceId));
          return new Set([...current].filter((id) => valid.has(id)));
        });
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    }
    load();
    const timer = window.setInterval(load, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (selectedDevices.length !== 1 || sending) return;
    const [device] = selectedDevices;
    setFrequency(device.frequency ?? 2.5);
    setAmplitude(device.amplitude ?? 28);
    setBias(device.bias ?? 0);
  }, [selectedDevices, sending]);

  function toggleDevice(deviceId) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }

  function selectOnline() {
    setSelectedIds(new Set(onlineDevices.map((device) => device.deviceId)));
  }

  function selectGroup(groupName) {
    const matches = onlineDevices.filter((device) => {
      const group = device.group || device.groupName || device.tags?.group;
      return group === groupName;
    });
    if (!matches.length) {
      setFeedback(`当前没有在线的 ${groupName} 组设备`);
      return;
    }
    setSelectedIds(new Set(matches.map((device) => device.deviceId)));
  }

  async function sendCommand(device, mode, override = null) {
    const params = override || {
      frequency: device.frequency ?? 2.5,
      amplitude: device.amplitude ?? 28,
      bias: device.bias ?? 0,
    };
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: device.deviceId,
        mode,
        frequency: clamp(params.frequency, 0.3, 5, 2.5),
        amplitude: clamp(params.amplitude, 0, 50, 28),
        bias: clamp(params.bias, -45, 45, 0),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.sent === false) {
      throw new Error(result.message || `${deviceLabel(device)} 发送失败`);
    }
    return result;
  }

  async function sendToSelection(mode) {
    if (!selectedOnline.length || sending) {
      if (!selectedOnline.length) setFeedback("请先选择至少一台在线机器鱼");
      return;
    }
    setSending(true);
    setFeedback(`正在向 ${selectedOnline.length} 台设备发送 ${MODE_LABELS[mode] || mode}…`);
    const shared = paramMode === "sync"
      ? { frequency, amplitude, bias }
      : null;
    const results = await Promise.allSettled(selectedOnline.map((device) => sendCommand(device, mode, shared)));
    const failed = results.filter((result) => result.status === "rejected");
    setFeedback(failed.length
      ? `已发送 ${results.length - failed.length}/${results.length} 台，${failed.length} 台失败`
      : `已发送：${MODE_LABELS[mode] || mode} · ${results.length} 台设备`);
    setSending(false);
  }

  async function stopAll() {
    if (!onlineDevices.length || sending) return;
    setSending(true);
    setFeedback(`ALL STOP：正在停止 ${onlineDevices.length} 台在线设备…`);
    const results = await Promise.allSettled(onlineDevices.map((device) => sendCommand(device, "stop")));
    const failed = results.filter((result) => result.status === "rejected").length;
    setFeedback(failed ? `ALL STOP 完成，${failed} 台未确认` : `ALL STOP 完成 · ${results.length} 台`);
    setSending(false);
  }

  async function otaSelection() {
    if (!selectedOnline.length || sending) {
      if (!selectedOnline.length) setFeedback("请先选择至少一台在线机器鱼");
      return;
    }
    if (!window.confirm(`确定升级所选 ${selectedOnline.length} 台设备？升级期间设备会停止并重启。`)) return;
    setSending(true);
    setFeedback(`正在创建 ${selectedOnline.length} 个 OTA 任务…`);
    const results = await Promise.allSettled(selectedOnline.map(async (device) => {
      const response = await fetch("/api/ota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: device.deviceId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.sent === false) throw new Error(result.message || "OTA 启动失败");
      return result;
    }));
    const failed = results.filter((result) => result.status === "rejected").length;
    setFeedback(failed ? `OTA 已启动 ${results.length - failed.length}/${results.length} 台` : `OTA 任务已发送 · ${results.length} 台`);
    setSending(false);
  }

  const targetTitle = selectedDevices.length === 0
    ? "未选择设备"
    : selectedDevices.length === 1
      ? deviceLabel(selectedDevices[0])
      : `已选择 ${selectedDevices.length} 台`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">F</div>
          <div><span className="eyebrow">FISH CONTROL CENTER</span><h1>多机器鱼视觉中央控制台</h1></div>
        </div>
        <div className="system-status">
          <span className="status online"><i /> Controller</span>
          <span className="status online"><i /> Camera</span>
          <span className="status online"><i /> Vision</span>
          <span className="status"><i /> Remote</span>
          <span className="online-summary"><strong>{onlineDevices.length}</strong> / {devices.length} 在线</span>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}，正在自动重试。</div>}

      <div className="workspace">
        <aside className="device-sidebar panel-surface">
          <div className="panel-heading">
            <div><span className="eyebrow">DEVICES</span><h2>机器鱼</h2></div>
            <span>{onlineDevices.length}/{devices.length}</span>
          </div>
          <div className="device-list">
            {devices.map((device) => {
              const selected = selectedIds.has(device.deviceId);
              return (
                <button
                  key={device.deviceId}
                  className={`device-row ${selected ? "selected" : ""}`}
                  disabled={!device.online}
                  onClick={() => toggleDevice(device.deviceId)}
                >
                  <span className="device-check">{selected ? "✓" : ""}</span>
                  <span className="device-main"><strong>{deviceLabel(device)}</strong><small>{MODE_LABELS[device.mode] || "未知"} · {device.frequency ?? "—"} Hz</small></span>
                  <span className={`signal ${device.online ? "online" : ""}`} />
                </button>
              );
            })}
            {!devices.length && <div className="sidebar-empty">等待设备上线…</div>}
          </div>
          <div className="quick-actions">
            <button onClick={selectOnline}>全选在线</button>
            <button onClick={() => setSelectedIds(new Set())}>取消选择</button>
          </div>
          <div className="sidebar-section">
            <span className="sidebar-label">快速分组</span>
            <div className="group-grid">
              <button onClick={() => selectGroup("A")}>A 组</button>
              <button onClick={() => selectGroup("B")}>B 组</button>
              <button onClick={selectOnline}>全部</button>
            </div>
          </div>
          <div className="sidebar-section">
            <span className="sidebar-label">系统入口</span>
            <div className="group-grid">
              <button>Camera</button><button>Remote</button><button onClick={otaSelection}>OTA</button>
            </div>
          </div>
        </aside>

        <section className="center-column">
          <VisionPanel />
        </section>

        <aside className="control-sidebar panel-surface">
          <section className="control-section target-section">
            <div className="panel-heading compact">
              <div><span className="eyebrow">CONTROL TARGET</span><h2>{targetTitle}</h2></div>
              <span className={`signal ${selectedOnline.length ? "online" : ""}`} />
            </div>
            <div className="selected-chips">
              {selectedDevices.map((device) => <span key={device.deviceId}>{deviceLabel(device)}</span>)}
            </div>
            <div className="stop-grid">
              <button className="danger-outline" disabled={!selectedOnline.length || sending} onClick={() => sendToSelection("stop")}>停止所选</button>
              <button className="danger-solid" disabled={!onlineDevices.length || sending} onClick={stopAll}>ALL STOP</button>
            </div>
          </section>

          <section className="control-section">
            <span className="sidebar-label">参数应用方式</span>
            <div className="param-mode-grid">
              <button className={paramMode === "sync" ? "active" : ""} onClick={() => setParamMode("sync")}>
                <strong>统一参数</strong><small>所选设备使用同一组参数</small>
              </button>
              <button className={paramMode === "keep" ? "active" : ""} onClick={() => setParamMode("keep")}>
                <strong>保留独立参数</strong><small>只同步动作，不覆盖参数</small>
              </button>
            </div>
          </section>

          {paramMode === "sync" ? (
            <section className="control-section">
              <span className="sidebar-label">统一控制参数</span>
              <label className="range-field"><span>频率 <b>{Number(frequency).toFixed(1)} Hz</b></span><input type="range" min="0.3" max="5" step="0.1" value={frequency} onChange={(event) => setFrequency(event.target.value)} /></label>
              <label className="range-field"><span>幅度 <b>{amplitude}°</b></span><input type="range" min="0" max="50" step="1" value={amplitude} onChange={(event) => setAmplitude(event.target.value)} /></label>
              <label className="range-field"><span>偏置 <b>{Number(bias) > 0 ? "+" : ""}{bias}°</b></span><input type="range" min="-45" max="45" step="1" value={bias} onChange={(event) => setBias(event.target.value)} /></label>
            </section>
          ) : (
            <section className="control-section">
              <span className="sidebar-label">当前独立参数</span>
              <div className="individual-params">
                {selectedDevices.map((device) => (
                  <div key={device.deviceId}><strong>{deviceLabel(device)}</strong><span>{device.frequency ?? "—"} Hz · {device.amplitude ?? "—"}° · {Number(device.bias ?? 0) > 0 ? "+" : ""}{device.bias ?? 0}°</span></div>
                ))}
                {!selectedDevices.length && <small>选择设备后显示各自参数</small>}
              </div>
            </section>
          )}

          <section className="control-section">
            <span className="sidebar-label">动作控制</span>
            <div className="motion-grid">
              {ACTIONS.map(([mode, label]) => <button key={mode} disabled={!selectedOnline.length || sending} onClick={() => sendToSelection(mode)}>{label}</button>)}
            </div>
            <p className="feedback" aria-live="polite">{feedback}</p>
          </section>

          <section className="control-section compact-actions">
            <button disabled={!selectedOnline.length || sending} onClick={otaSelection}>升级所选设备固件</button>
          </section>
        </aside>
      </div>

      <footer className="app-footer">
        <span>选择集驱动控制：单鱼 / 多鱼 / 分组 / 全部使用同一控制面板</span>
        <span>{selectedOnline.length ? `当前目标：${selectedOnline.length} 台在线设备` : "当前未选择在线设备"}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
