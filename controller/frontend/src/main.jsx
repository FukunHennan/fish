import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import VisionPanel from "./VisionPanel.jsx";

const MODES = ["停止", "待机", "前进", "左转", "右转"];
const ACTIONS = [
  ["forward", "前进"],
  ["left", "左转"],
  ["right", "右转"],
  ["idle", "待机"],
];

function formatUptime(milliseconds = 0) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}时 ${minutes}分 ${seconds % 60}秒`;
}

function DeviceCard({ device }) {
  const [frequency, setFrequency] = useState(device.frequency || 2.5);
  const [amplitude, setAmplitude] = useState(device.amplitude || 28);
  const [bias, setBias] = useState(device.bias || 0);
  const [feedback, setFeedback] = useState("等待控制指令");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!sending) {
      setFrequency(device.frequency || 2.5);
      setAmplitude(device.amplitude || 28);
      setBias(device.bias || 0);
    }
  }, [device.frequency, device.amplitude, device.bias, sending]);

  async function send(mode) {
    if (!device.online || sending) return;
    setSending(true);
    setFeedback("正在发送…");
    try {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: device.deviceId,
          mode,
          frequency: Number(frequency),
          amplitude: Number(amplitude),
          bias: Number(bias),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "参数无效");
      setFeedback(result.sent ? `已发送 · ${result.requestId}` : "发送失败：设备不在线");
    } catch (error) {
      setFeedback(`发送失败：${error.message}`);
    } finally {
      setSending(false);
    }
  }

  async function startOta() {
    if (!device.online || sending) return;
    if (!window.confirm(`确定将内置新固件升级到 ${device.name || "该设备"}？升级期间设备会停止并重启。`)) return;
    setSending(true); setFeedback("正在启动固件升级…");
    try {
      const response = await fetch("/api/ota", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({deviceId:device.deviceId})});
      const result = await response.json(); if(!response.ok||!result.sent) throw new Error(result.message||"固件不可用或设备不在线");
      setFeedback("升级命令已发送，请等待设备重启并重新上线");
    } catch(error) { setFeedback(`升级失败：${error.message}`); } finally { setSending(false); }
  }

  return (
    <article className="device-card">
      <header className="device-header">
        <div>
          <div className="eyebrow">DEVICE / {device.deviceId}</div>
          <h2>{device.name || "未命名机器鱼"}</h2>
        </div>
        <span className={`status ${device.online ? "online" : "offline"}`}>
          <i /> {device.online ? "在线" : "离线"}
        </span>
      </header>

      <section className="metrics" aria-label="设备信息">
        <div><span>IP 地址</span><strong>{device.ip || "—"}</strong></div>
        <div><span>固件版本</span><strong>{device.firmwareVersion || "—"}</strong></div>
        <div><span>信号强度</span><strong>{device.rssi ? `${device.rssi} dBm` : "—"}</strong></div>
        <div><span>运行时间</span><strong>{formatUptime(device.uptimeMs)}</strong></div>
        <div><span>当前模式</span><strong>{MODES[device.mode] || "未知"}</strong></div>
        <div><span>停止原因</span><strong>{device.stopReason || "无"}</strong></div>
      </section>

      <section className="control-panel" aria-label="运动控制">
        <div className="section-title">
          <div><span>MANUAL CONTROL</span><h3>运动控制</h3></div>
          <p>参数随下一条指令一起发送</p>
        </div>
        <div className="fields">
          <label>频率 <small>0.3–5.0 Hz</small><input type="number" min="0.3" max="5" step="0.1" value={frequency} onChange={(e) => setFrequency(e.target.value)} /></label>
          <label>幅度 <small>0–50°</small><input type="number" min="0" max="50" step="1" value={amplitude} onChange={(e) => setAmplitude(e.target.value)} /></label>
          <label>偏置 <small>-45–45°</small><input type="number" min="-45" max="45" step="1" value={bias} onChange={(e) => setBias(e.target.value)} /></label>
        </div>
        <div className="actions">
          {ACTIONS.map(([mode, label]) => <button key={mode} disabled={!device.online || sending} onClick={() => send(mode)}>{label}</button>)}
          <button className="stop" disabled={!device.online || sending} onClick={() => send("stop")}>立即停止</button>
        </div>
        <p className="feedback" aria-live="polite">{feedback}</p>
        <button disabled={!device.online || sending} onClick={startOta}>升级设备固件</button>
      </section>
    </article>
  );
}

function App() {
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const onlineCount = useMemo(() => devices.filter((device) => device.online).length, [devices]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/devices", { cache: "no-store" });
        if (!response.ok) throw new Error("控制器接口不可用");
        const data = await response.json();
        if (active) { setDevices(data); setError(""); }
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    }
    load();
    const timer = window.setInterval(load, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return (
    <main>
      <header className="topbar">
        <div className="brand-mark">F</div>
        <div><span className="eyebrow">LAN CONTROL SYSTEM</span><h1>机器鱼控制台</h1></div>
        <div className="summary"><strong>{onlineCount}</strong><span>在线设备 / {devices.length} 总数</span></div>
      </header>
      {error && <div className="error-banner" role="alert">{error}，正在自动重试。</div>}
      <VisionPanel />
      {!devices.length && !error ? (
        <section className="empty"><div className="radar" /><h2>正在等待机器鱼</h2><p>请确认设备与电脑连接到同一个局域网；设备会自动发现本机，无需填写电脑 IP。</p></section>
      ) : (
        <section className="device-grid">{devices.map((device) => <DeviceCard key={device.deviceId} device={device} />)}</section>
      )}
      <footer>机器鱼设备与视觉统一控制界面</footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
