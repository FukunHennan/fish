import { batteryLevel, deviceLabel, leaseSummary } from "../ui/devicePresentation.js";

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

function deviceState(device, page, selected, visionState, user) {
  if (!device.online) return "离线";
  if (page === "vision" && selected) {
    if (visionState?.metrics?.workflow?.trackingActive || visionState?.state === "tracking") return "视觉控制";
    if (Number(visionState?.metrics?.yolo?.detectionCount) === 1) return "已识别";
    return "视觉目标";
  }
  if (page === "manual") return leaseSummary(device, user).label;
  return MODE_LABELS[device.mode] || "在线";
}

export default function DeviceRail({
  devices = [],
  selectedId = "",
  onSelect = () => {},
  page = "manual",
  user = null,
  visionState = null,
  disabled = false,
}) {
  const onlineCount = devices.filter((device) => device.online).length;
  return (
    <aside className="device-rail" aria-label="设备列表">
      <header className="rail-header">
        <span className="section-kicker">{page === "vision" ? "VISION TARGETS" : "DEVICES"}</span>
        <span className="device-count">{onlineCount} 在线</span>
        <h2>设备列表</h2>
        <p>{page === "vision" ? "选择设备作为视觉身份绑定目标。" : "固定注册顺序，状态变化不会重新排列。"}</p>
      </header>
      <div className="device-list" role="list">
        {devices.map((device) => {
          const selected = device.deviceId === selectedId;
          const battery = batteryLevel(device);
          const status = page === "manual"
            ? leaseSummary(device, user).label
            : deviceState(device, page, selected, visionState, user);
          const batteryLabel = battery == null ? "电量 —" : `电量 ${battery}%`;
          const lease = page === "manual" ? leaseSummary(device, user) : null;
          const visionBound = visionState?.targetDeviceId === device.deviceId;
          const visionBinding = visionBound && visionState?.targetTrackId != null
            ? `目标 #${visionState.targetTrackId}`
            : visionBound
              ? "等待识别目标"
              : "未绑定目标";
          const detail = page === "manual"
            ? `${batteryLabel} · ${lease?.owner === "—" ? "空闲" : lease?.owner || "他人"}`
            : page === "vision"
              ? `${batteryLabel} · ${visionBinding}`
              : batteryLabel;
          return (
            <button
              className={`device-row ${selected ? "active" : ""} ${device.online ? "" : "offline"}`}
              key={device.deviceId}
              type="button"
              disabled={disabled || !device.online}
              onClick={() => onSelect(device)}
              role="listitem"
            >
              <i className={`signal ${device.online ? "" : "offline"}`} />
              <span>
                <strong className="device-name">{deviceLabel(device)}</strong>
                <small className="device-id">{device.deviceId}{device.ip ? ` · ${device.ip}` : ""}</small>
                <small className="device-meta">{detail}</small>
              </span>
              <span className="device-state">{status}</span>
            </button>
          );
        })}
        {!devices.length && <div className="rail-empty">暂无设备</div>}
      </div>
      <div className="rail-summary">
        <strong>列表状态</strong><br />
        设备按首次注册顺序保留，离线设备也不会被移动。
      </div>
    </aside>
  );
}
