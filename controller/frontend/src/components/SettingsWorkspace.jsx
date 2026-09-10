import { useEffect, useState } from "react";
import AdminUsers from "./AdminUsers.jsx";
import { deviceLabel, formatBytes, formatTime, roleLabel } from "../ui/devicePresentation.js";

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

const ADMIN_TABS = [
  ["account", "账户管理"],
  ["devices", "设备与状态"],
  ["servo", "舵机标定"],
  ["rgb", "RGB 灯光"],
  ["ota", "固件与 OTA"],
];

const USER_TABS = [
  ["profile", "我的账户"],
  ["devices", "设备状态"],
  ["servo", "舵机标定"],
  ["rgb", "RGB 灯光"],
];

function TabButton({ active, id, children, onClick }) {
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      aria-current={active ? "page" : undefined}
      onClick={() => onClick(id)}
    >
      {children}
    </button>
  );
}

function SettingsBlock({ title, children, full = false }) {
  return (
    <section className={`settings-block ${full ? "full" : ""}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function DeviceOverview({ devices = [], onlineDevices = [], lowBatteryCount = 0 }) {
  return (
    <>
      <SettingsBlock title="设备状态总览">
        <p>
          在线设备 {onlineDevices.length}/{devices.length}
          <br />
          低电量设备 {lowBatteryCount} 台
          <br />
          列表顺序：首次注册顺序
        </p>
      </SettingsBlock>
      <SettingsBlock title="运行状态">
        <p>
          状态源：ESP32 heartbeat / state
          <br />
          设备列表：状态更新不触发排序
          <br />
          页面只在有效状态变化时刷新
        </p>
      </SettingsBlock>
      <SettingsBlock title="设备状态明细" full>
        <div className="settings-device-list">
          {devices.map((device) => (
            <div className="settings-device-row" key={device.deviceId}>
              <div>
                <strong>{deviceLabel(device)}</strong>
                <small>{device.deviceId} · {device.mac || device.ip || "地址未知"}</small>
              </div>
              <span className={device.online ? "online-text" : "offline-text"}>
                {device.online ? "● 在线" : "○ 离线"}
              </span>
              <span>{MODE_LABELS[device.mode] || "未知"}</span>
              <span>{device.online && device.rssi ? `${device.rssi} dBm` : "信号 —"}</span>
              <span>{device.online && Number.isFinite(device.batteryPercent) ? `${device.batteryPercent}%` : "电量 —"}</span>
            </div>
          ))}
          {!devices.length && <p>等待 ESP32 设备上线。</p>}
        </div>
      </SettingsBlock>
    </>
  );
}

function DeviceCalibration({
  devices = [],
  isAdmin,
  sending,
  deviceNeutralCenter,
  updateLocalNeutral,
  saveDeviceNeutral,
  openRename,
}) {
  return (
    <SettingsBlock title="舵机标定" full>
      <p className="settings-note">
        {isAdmin
          ? "管理员可以维护设备的舵机中位，保存后写入服务器标定配置并同步在线设备。"
          : "普通用户可以调整设备中位和个人运动参数，不能修改固件。"}
      </p>
      <div className="settings-device-list calibration-list">
        {devices.map((device) => (
          <div className="settings-device-row calibration-row" key={device.deviceId}>
            <div>
              <strong>{deviceLabel(device)}</strong>
              <small>{device.deviceId} · 最后在线 {formatTime(device.lastSeen)}</small>
            </div>
            <label className="settings-range">
              <span>中位 <b>{Number(deviceNeutralCenter(device)).toFixed(0)}°</b></span>
              <input
                type="range"
                min="45"
                max="135"
                step="1"
                value={deviceNeutralCenter(device)}
                disabled={sending}
                onChange={(event) => updateLocalNeutral(device, event.target.value)}
                onPointerUp={(event) => saveDeviceNeutral(device, event.currentTarget.value)}
                onKeyUp={(event) => saveDeviceNeutral(device, event.currentTarget.value)}
              />
            </label>
            {isAdmin && (
              <button type="button" className="quiet" onClick={() => openRename(device)}>
                重命名
              </button>
            )}
          </div>
        ))}
        {!devices.length && <p>设备上线后可以在这里调整舵机中位。</p>}
      </div>
    </SettingsBlock>
  );
}

function RgbSettings({
  devices = [],
  rgbColor,
  setRgbColor,
  rgbBrightness,
  setRgbBrightness,
  rgbOrder,
  setRgbOrder,
  setRgb,
}) {
  return (
    <SettingsBlock title="RGB 灯光" full>
      <p className="settings-note">灯光设置会在设备确认后显示为已应用状态。</p>
      <div className="settings-device-list">
        {devices.map((device) => (
          <div className="settings-device-row rgb-row" key={device.deviceId}>
            <div>
              <strong>{deviceLabel(device)}</strong>
              <small>{device.deviceId} · {device.online ? "可以下发" : "设备离线"}</small>
            </div>
              <label className="settings-color">
                <span>颜色</span>
                <input type="color" value={rgbColor} disabled={!device.online} onChange={(event) => setRgbColor(event.target.value)} />
              </label>
              <label className="settings-select">
                <span>色序</span>
                <select value={rgbOrder} disabled={!device.online} onChange={(event) => setRgbOrder(event.target.value)}>
                  {["RGB", "GRB", "RBG", "GBR", "BRG", "BGR"].map((order) => <option key={order}>{order}</option>)}
                </select>
              </label>
              <label className="settings-range compact">
                <span>亮度 <b>{rgbBrightness}</b></span>
                <input
                  type="range"
                  min="1"
                  max="255"
                  value={rgbBrightness}
                  disabled={!device.online}
                  onChange={(event) => setRgbBrightness(event.target.value)}
                  onPointerUp={() => setRgb(device, device.rgbMode === "SOLID" ? "SOLID" : "AUTO")}
                  onKeyUp={() => setRgb(device, device.rgbMode === "SOLID" ? "SOLID" : "AUTO")}
                />
            </label>
            <div className="settings-inline-actions">
              <button type="button" disabled={!device.online} onClick={() => setRgb(device, "SOLID")}>应用颜色</button>
              <button type="button" disabled={!device.online} onClick={() => setRgb(device, "AUTO")}>自动模式</button>
            </div>
          </div>
        ))}
        {!devices.length && <p>设备上线后可以在这里设置 RGB 灯光。</p>}
      </div>
    </SettingsBlock>
  );
}

function OtaSettings({
  devices,
  firmwareInfo,
  firmwareFile,
  setFirmwareFile,
  uploading,
  uploadProgress,
  startOta,
  otaFeedback,
  otaSelectedDevices,
  otaSelectedIds,
  selectOtaOnline,
  toggleOtaDevice,
}) {
  const activeDevices = devices.filter((device) => device.otaState && device.otaState !== "IDLE");
  const otaRunning = activeDevices.some((device) => ["DOWNLOADING", "REBOOTING"].includes(device.otaState));
  const otaComplete = activeDevices.length > 0 && activeDevices.every((device) => device.otaState === "REBOOTING");
  const otaStateLabel = {
    DOWNLOADING: "下载中",
    REBOOTING: "即将重启",
    FAILED: "失败",
  };
  const progressTrack = (device, overall = false) => {
    const active = overall || device?.otaState === "DOWNLOADING";
    const progress = Number(device?.otaProgress) || 0;
    return (
      <span className={`ota-progress-track ${active ? "indeterminate" : ""}`}>
        <i style={active ? undefined : { width: `${progress}%` }} />
      </span>
    );
  };

  return (
    <SettingsBlock title="固件与 OTA" full>
      <div className="ota-summary">
        <div>
          <span className="section-kicker">FIRMWARE</span>
          <strong>{firmwareInfo.available ? firmwareInfo.name : "尚未准备固件"}</strong>
          <small>{firmwareInfo.available ? `${formatBytes(firmwareInfo.size)} · SHA-256 已校验` : "上传一个 ESP32 .bin 文件开始"}</small>
        </div>
        <span className={`firmware-ready ${firmwareInfo.available ? "ready" : ""}`}>
          {firmwareInfo.available ? "已就绪" : "待上传"}
        </span>
      </div>
      <label className="local-bin-picker">
        <input
          type="file"
          accept=".bin,application/octet-stream"
          onChange={(event) => setFirmwareFile(event.target.files?.[0] || null)}
        />
        <strong>{firmwareFile ? firmwareFile.name : "选择 firmware.bin"}</strong>
        <small>{firmwareFile ? formatBytes(firmwareFile.size) : "点击选择本地固件"}</small>
      </label>
      <div className="settings-actions">
        <button className="action" type="button" disabled={(!firmwareInfo.available && !firmwareFile) || !otaSelectedDevices.length || uploading || otaRunning} onClick={startOta}>
          {uploading ? `准备中 ${uploadProgress}%` : "开始升级"} {otaSelectedDevices.length ? `· ${otaSelectedDevices.length} 台` : ""}
        </button>
      </div>
      {uploading && (
        <div className="ota-progress-block">
          <div className="ota-progress-heading"><span>正在上传固件</span><b>{uploadProgress}%</b></div>
          <div className="ota-progress-track"><i style={{ width: `${uploadProgress}%` }} /></div>
        </div>
      )}
      <div className="ota-target-header">
        <div><span className="sidebar-label no-pad">升级目标</span><small>{otaSelectedDevices.length} 台在线设备已选择</small></div>
        <div>
          <button type="button" onClick={selectOtaOnline}>全选</button>
          <button type="button" onClick={() => toggleOtaDevice("clear")}>清空</button>
        </div>
      </div>
      <div className="ota-device-grid">
        {devices.map((device) => {
          const selected = otaSelectedIds.has(device.deviceId);
          return (
            <button
              key={device.deviceId}
              type="button"
              className={`ota-device-card ${selected ? "selected" : ""}`}
              disabled={!device.online}
              onClick={() => toggleOtaDevice(device.deviceId)}
            >
              <span className="device-check">{selected ? "✓" : ""}</span>
              <span><strong>{deviceLabel(device)}</strong><small>{device.deviceId}</small></span>
              <em>{device.online ? (otaStateLabel[device.otaState] || "在线") : "离线"}</em>
              {device.otaState && device.otaState !== "IDLE" && (
                <span className="ota-device-progress">
                  {progressTrack(device)}
                  <b>{device.otaState === "DOWNLOADING" ? "进行中" : `${Number(device.otaProgress) || 0}%`}</b>
                </span>
              )}
            </button>
          );
        })}
      </div>
      {otaRunning && (
        <div className="ota-progress-block overall">
          <div className="ota-progress-heading"><span>正在升级 · {activeDevices.length} 台设备</span><b>进行中</b></div>
          {progressTrack(null, true)}
        </div>
      )}
      {otaComplete && <p className="ota-complete">设备已完成写入，正在重启并重新上线。</p>}
      <p className="feedback" aria-live="polite">{otaFeedback}</p>
    </SettingsBlock>
  );
}

export default function SettingsWorkspace({
  authUser,
  isAdmin,
  devices = [],
  onlineDevices = [],
  lowBatteryCount = 0,
  sending = false,
  stopAll = () => {},
  onLogout = () => {},
  firmwareInfo = { available: false },
  firmwareFile = null,
  setFirmwareFile = () => {},
  uploading = false,
  uploadProgress = 0,
  startOta = () => {},
  otaFeedback = "",
  otaSelectedDevices = [],
  otaSelectedIds = new Set(),
  selectOtaOnline = () => {},
  toggleOtaDevice = () => {},
  deviceNeutralCenter = () => 90,
  updateLocalNeutral = () => {},
  saveDeviceNeutral = () => {},
  rgbColor = "#00ff66",
  setRgbColor = () => {},
  rgbBrightness = 32,
  setRgbBrightness = () => {},
  rgbOrder = "GRB",
  setRgbOrder = () => {},
  setRgb = () => {},
  openRename = () => {},
}) {
  const tabs = isAdmin ? ADMIN_TABS : USER_TABS;
  const [activeTab, setActiveTab] = useState(tabs[0][0]);

  useEffect(() => {
    if (!tabs.some(([id]) => id === activeTab)) setActiveTab(tabs[0][0]);
  }, [activeTab, isAdmin, tabs]);

  const title = tabs.find(([id]) => id === activeTab)?.[1] || tabs[0][1];
  const intro = isAdmin
    ? "管理员工作区：账户处理、设备运维和固件升级。"
    : "普通用户工作区：账户、设备状态、舵机和 RGB 参数。";

  function renderContent() {
    if (isAdmin && activeTab === "account") return <AdminUsers currentUser={authUser} />;
    if (activeTab === "profile") {
      return (
        <>
          <SettingsBlock title="个人资料">
            <p>姓名：{authUser?.name || "未命名用户"}<br />邮箱：{authUser?.email || "—"}<br />账户类型：{roleLabel(authUser)}</p>
          </SettingsBlock>
          <SettingsBlock title="密码安全">
            <p>系统只保存密码摘要。管理员也不能读取密码明文，需要时只能执行重置。</p>
          </SettingsBlock>
          <SettingsBlock title="普通用户可用功能" full>
            <p>手动控制、视觉识别、设备在线状态、舵机中位和 RGB 设置。账户管理、固件上传和 OTA 仍由管理员负责。</p>
          </SettingsBlock>
        </>
      );
    }
    if (activeTab === "devices") return <DeviceOverview devices={devices} onlineDevices={onlineDevices} lowBatteryCount={lowBatteryCount} />;
    if (activeTab === "servo") return (
      <DeviceCalibration
        devices={devices}
        isAdmin={isAdmin}
        sending={sending}
        deviceNeutralCenter={deviceNeutralCenter}
        updateLocalNeutral={updateLocalNeutral}
        saveDeviceNeutral={saveDeviceNeutral}
        openRename={openRename}
      />
    );
    if (activeTab === "rgb") return (
      <RgbSettings
        devices={devices}
        rgbColor={rgbColor}
        setRgbColor={setRgbColor}
        rgbBrightness={rgbBrightness}
        setRgbBrightness={setRgbBrightness}
        rgbOrder={rgbOrder}
        setRgbOrder={setRgbOrder}
        setRgb={setRgb}
      />
    );
    if (activeTab === "ota") return (
      <OtaSettings
        devices={devices}
        firmwareInfo={firmwareInfo}
        firmwareFile={firmwareFile}
        setFirmwareFile={setFirmwareFile}
        uploading={uploading}
        uploadProgress={uploadProgress}
        startOta={startOta}
        otaFeedback={otaFeedback}
        otaSelectedDevices={otaSelectedDevices}
        otaSelectedIds={otaSelectedIds}
        selectOtaOnline={selectOtaOnline}
        toggleOtaDevice={toggleOtaDevice}
      />
    );
    return (
      <SettingsBlock title="管理员权限" full>
        <p>账户管理、设备运维、固件 OTA、RGB 和舵机标定。管理员不能查看任何账户的密码。</p>
      </SettingsBlock>
    );
  }

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="系统设置">
        {tabs.map(([id, label]) => (
          <TabButton key={id} id={id} active={activeTab === id} onClick={setActiveTab}>{label}</TabButton>
        ))}
        <div className="settings-nav-footer">
          <button type="button" className="quiet" onClick={onLogout}>退出登录</button>
          {isAdmin && <button type="button" className="danger" disabled={!onlineDevices.length || sending} onClick={stopAll}>全部停止</button>}
        </div>
      </nav>
      <main className="settings-content">
        <span className="section-kicker">SYSTEM SETTINGS</span>
        <h1>{title}</h1>
        <p>{intro}</p>
        <div className="settings-form">{renderContent()}</div>
      </main>
    </div>
  );
}
