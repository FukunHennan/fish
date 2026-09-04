import { batteryLevel, deviceLabel, formatTime, leaseIsMine, leaseSummary } from "../ui/devicePresentation.js";

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

export default function ManualInspector({
  device = null,
  user = null,
  devices = [],
  leaseBusy = false,
  onClaim = () => {},
  onRelease = () => {},
  onMotion = () => {},
  motion = { frequency: 2.5, amplitudePercent: 40 },
  onMotionChange = () => {},
  feedback = "",
  keyboardStatus = { phase: "idle", mode: "stop", deviceId: "", message: "" },
}) {
  const lease = leaseSummary(device, user);
  const canControl = lease.mine;
  const battery = batteryLevel(device);
  const keyboardDevice = devices.find((item) => item.deviceId === keyboardStatus.deviceId);
  return (
    <aside className="inspector" aria-label="当前设备检查器">
      <header className="inspector-header">
        <div>
          <span className="section-kicker">ACTIVE DEVICE</span>
          <h2>{device ? deviceLabel(device) : "未选择设备"}</h2>
          <p>{device ? `${device.deviceId}${device.ip ? ` · ${device.ip}` : ""}` : "从左侧选择一台在线设备"}</p>
        </div>
        <span className={`inspector-state ${device?.online ? "online" : ""}`}>{device?.online ? "● 在线" : "○ 离线"}</span>
      </header>

      {!device ? (
        <section className="inspector-section"><p className="inspector-empty">选择设备后显示控制权和实时状态。</p></section>
      ) : (
        <>
          <section className="inspector-section">
            <h3>实时状态</h3>
            <div className="metric-grid">
              <div className="metric"><span>设备动作</span><strong>{MODE_LABELS[device.mode] || "未知"}</strong></div>
              <div className="metric"><span>控制来源</span><strong>{device.controlSource || "—"}</strong></div>
              <div className="metric"><span>电量</span><strong>{battery == null ? "—" : `${battery}%`}</strong></div>
              <div className="metric"><span>信号</span><strong>{device.rssi ? `${device.rssi} dBm` : "—"}</strong></div>
            </div>
            <p className="inspector-note">状态来自 ESP32 heartbeat / state / command.result。</p>
          </section>

          <section className="inspector-section">
            <h3>运动控制</h3>
            <div className="control-pad" aria-label="运动控制">
              <span className="empty" />
              <button type="button" disabled={!canControl || leaseBusy} className={device.mode === 2 ? "selected" : ""} onClick={() => onMotion("forward")}>前进</button>
              <span className="empty" />
              <button type="button" disabled={!canControl || leaseBusy} className={device.mode === 3 ? "selected" : ""} onClick={() => onMotion("left")}>左转</button>
              <button type="button" disabled={!canControl || leaseBusy} className="stop" onClick={() => onMotion("stop")}>停止</button>
              <button type="button" disabled={!canControl || leaseBusy} className={device.mode === 4 ? "selected" : ""} onClick={() => onMotion("right")}>右转</button>
            </div>
            <label className="range-row"><span>频率</span><input type="range" min="0.3" max="5" step="0.1" value={motion.frequency} disabled={!canControl || leaseBusy} onChange={(event) => onMotionChange("frequency", Number(event.target.value))} /><output>{motion.frequency.toFixed(1)} Hz</output></label>
            <label className="range-row"><span>摆尾幅度</span><input type="range" min="0" max="100" step="1" value={motion.amplitudePercent} disabled={!canControl || leaseBusy} onChange={(event) => onMotionChange("amplitudePercent", Number(event.target.value))} /><output>{Math.round(motion.amplitudePercent)}%</output></label>
          </section>

          <section className={`inspector-section manual-lease-panel ${lease.className}`}>
            <div className="manual-lease-head"><div><span className="section-kicker">CONTROL LEASE</span><strong>控制权</strong></div><b>{lease.label}</b></div>
            <div className="manual-lease-grid">
              <div><span>控制者</span><strong>{lease.owner}</strong></div>
              <div><span>账户</span><strong>{lease.account}</strong></div>
              <div><span>租约状态</span><strong>{device.lease ? `有效至 ${formatTime(device.lease.expiresAt)}` : "等待接管"}</strong></div>
              <div><span>设备动作</span><strong>{MODE_LABELS[device.mode] || "未知"}</strong></div>
            </div>
            {lease.mine && <button className="lease-button release" type="button" disabled={leaseBusy} onClick={onRelease}>停止并释放控制权</button>}
            {!device.lease && <button className="lease-button claim" type="button" disabled={leaseBusy} onClick={onClaim}>接管当前设备</button>}
            {device.lease && !lease.mine && <p className="lease-note">当前设备由 {lease.owner} 控制。你可以查看状态，但不能发送运动指令。</p>}
          </section>

          <section className="inspector-section">
            <h3>命令反馈</h3>
            <div className={`keyboard-status ${keyboardStatus.phase}`}>
              <span className="keyboard-status-dot" />
              <span>{keyboardDevice ? `${deviceLabel(keyboardDevice)} · ` : ""}{keyboardStatus.message || "键盘控制待命"}</span>
              {keyboardStatus.mode && keyboardStatus.mode !== "stop" && <b>{MODE_LABELS[keyboardStatus.mode] || keyboardStatus.mode}</b>}
            </div>
            <p className="feedback">{feedback || "命令只表达控制意图，实际动作以设备状态为准。"}</p>
          </section>
        </>
      )}
    </aside>
  );
}
