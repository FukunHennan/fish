import TelemetryIcon from "./TelemetryIcon.jsx";
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
  const rssi = device?.rssi != null && device.rssi !== "" && Number.isFinite(Number(device.rssi)) && Number(device.rssi) < 0 ? Number(device.rssi) : null;
  const keyboardDevice = devices.find((item) => item.deviceId === keyboardStatus.deviceId);
  return (
    <aside className="inspector" aria-label="当前设备检查器">
      <header className="inspector-header">
        <div>
          <h2>{device ? deviceLabel(device) : "未选择设备"}</h2>
        </div>
        <span className={`inspector-state ${device?.online ? "online" : ""}`}>{device?.online ? "● 在线" : "○ 离线"}</span>
      </header>

      {!device ? (
        <section className="inspector-section"><p className="inspector-empty">请选择设备</p></section>
      ) : (
        <>
          <section className="inspector-section">
            <div className="metric-grid compact-telemetry">
              <div className="metric icon-metric motion-metric">
                <TelemetryIcon kind="motion" value={device.mode} />
                <span>动作</span><strong>{MODE_LABELS[device.mode] || "未知"}</strong>
              </div>
              <div className={`metric icon-metric ${battery != null && battery <= 20 ? "telemetry-low" : ""}`}>
                <TelemetryIcon kind="battery" value={battery} />
                <span>电量</span><strong>{battery == null ? "—" : `${battery}%`}</strong>
              </div>
              <div className="metric icon-metric" title="图标表示信号强弱，数值为设备上报 RSSI">
                <TelemetryIcon kind="signal" value={rssi} />
                <span>信号</span><strong>{rssi == null ? "—" : <>{rssi}<small> dBm</small></>}</strong>
              </div>
            </div>
          </section>

          <section className="inspector-section">
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
            <div className="manual-lease-head"><strong>控制权</strong><b>{lease.label}</b></div>
            {lease.mine && <button className="lease-button release" type="button" disabled={leaseBusy} onClick={onRelease}>停止并释放控制权</button>}
            {!device.lease && <button className="lease-button claim" type="button" disabled={leaseBusy} onClick={onClaim}>接管当前设备</button>}
            {device.lease && !lease.mine && <p className="lease-note">{lease.owner} 正在控制</p>}
          </section>

          <section className="inspector-section inspector-detail-section">
            <details className="device-details"><summary>设备详情</summary>
              <dl><dt>设备 ID</dt><dd>{device.deviceId}</dd><dt>IP</dt><dd>{device.ip || "—"}</dd><dt>控制来源</dt><dd>{device.controlSource || "—"}</dd><dt>控制者</dt><dd>{lease.owner}</dd><dt>账户</dt><dd>{lease.account}</dd><dt>有效至</dt><dd>{device.lease ? formatTime(device.lease.expiresAt) : "—"}</dd></dl>
            </details>
            {keyboardStatus.phase !== "idle" &&
            <div className={`keyboard-status ${keyboardStatus.phase}`}>
              <span className="keyboard-status-dot" />
              <span>{keyboardDevice ? `${deviceLabel(keyboardDevice)} · ` : ""}{keyboardStatus.message || "键盘控制待命"}</span>
              {keyboardStatus.mode && keyboardStatus.mode !== "stop" && <b>{MODE_LABELS[keyboardStatus.mode] || keyboardStatus.mode}</b>}
            </div>
            }
            {feedback && <p className="feedback" role="status">{feedback}</p>}
          </section>
        </>
      )}
    </aside>
  );
}
