const devices = [
  { id: "Fish001", name: "机器鱼 1", ip: "192.168.1.31", mode: "forward", battery: 85, rssi: -52, source: "manual", online: true, lease: { ownerId: "admin-1", ownerName: "陈富坤", ownerEmail: "chenfukun@example.com", mode: "manual", expiresAt: "2026-09-03T10:27:00+08:00" } },
  { id: "Fish002", name: "机器鱼 2", ip: "192.168.1.32", mode: "stop", battery: 64, rssi: -61, source: "idle", online: true },
  { id: "Fish003", name: "机器鱼 3", ip: "192.168.1.33", mode: "left", battery: 27, rssi: -74, source: "vision", online: true, lease: { ownerId: "user-1", ownerName: "实验员", ownerEmail: "operator@example.com", mode: "vision", expiresAt: "2026-09-03T10:25:00+08:00" } },
  { id: "Fish004", name: "机器鱼 4", ip: "—", mode: "stop", battery: null, rssi: null, source: "offline", online: false },
];

const modeLabels = { stop: "停止", idle: "待机", forward: "前进", left: "左转", right: "右转" };
const accounts = [
  { id: "admin-1", name: "陈富坤", email: "chenfukun@example.com", role: "Admin", status: "启用", lastLogin: "2026-09-03 09:57" },
  { id: "admin-2", name: "FanDiXia", email: "fandixia@example.com", role: "Admin", status: "启用", lastLogin: "2026-09-01 17:20" },
  { id: "user-1", name: "实验员", email: "operator@example.com", role: "User", status: "启用", lastLogin: "2026-09-02 14:18" },
];
const visionTargets = [
  { trackId: 1, confidence: 92, color: "青色", colorHex: "#42d4c1", deviceId: "Fish001", position: "画面 28% / 32%" },
  { trackId: 2, confidence: 78, color: "黄色", colorHex: "#f0ba67", deviceId: "Fish003", position: "画面 61% / 55%" },
  { trackId: 3, confidence: 65, color: "蓝色", colorHex: "#8fb7ff", deviceId: "", position: "画面 17% / 70%" },
];
const state = {
  page: "manual",
  role: "Admin",
  selectedId: "Fish001",
  direction: "forward",
  speed: 2.5,
  amplitude: 40,
  visionMode: "detect",
  visionTrackId: 1,
  visionBindingId: "Fish001",
  visionControlActive: false,
  settingsTab: "account",
  feedback: "已连接控制服务器，等待控制指令。",
  accountDraft: { name: "", email: "", role: "User" },
  pressed: new Set(),
};

function selectedDevice() {
  return devices.find((device) => device.id === state.selectedId) || devices[0];
}

function selectedVisionTarget() {
  return visionTargets.find((target) => target.trackId === state.visionTrackId) || null;
}

function isAdmin() {
  return state.role === "Admin";
}

function roleLabel(role = state.role) {
  return role === "Admin" ? "管理员" : "普通用户";
}

function currentAccount() {
  return isAdmin() ? accounts[0] : accounts.find((account) => account.role === "User") || accounts[0];
}

function leaseIsMine(device) {
  return Boolean(device?.lease && device.lease.ownerId === currentAccount().id);
}

function leaseSummary(device) {
  if (!device?.lease) return { className: "free", label: "空闲", owner: "—", account: "尚未接管", mine: false };
  if (leaseIsMine(device)) {
    return { className: "mine", label: "我的控制", owner: "我 · " + device.lease.ownerName, account: device.lease.ownerEmail, mine: true };
  }
  return { className: "other", label: "他人控制", owner: device.lease.ownerName, account: device.lease.ownerEmail, mine: false };
}

function keyboardDirection() {
  if (state.pressed.has("A")) return "left";
  if (state.pressed.has("D")) return "right";
  if (state.pressed.has("W")) return "forward";
  return "stop";
}

function applyKeyboardDirection() {
  const direction = keyboardDirection();
  state.direction = direction;
  if (state.page !== "manual") return direction;

  const device = selectedDevice();
  if (direction !== "stop" && !leaseIsMine(device)) {
    state.feedback = `${device.name} 当前不是你的控制权，请先接管设备。`;
    return direction;
  }
  if (direction === "stop" && !leaseIsMine(device)) return direction;
  device.mode = direction;
  device.source = "manual";
  state.feedback = `键盘意图：${modeLabels[direction]}。转弯优先于直行。`;
  return direction;
}

function app() {
  const root = document.querySelector("#app");
  root.innerHTML = state.page === "settings" ? settingsView() : workspaceView();
  bindEvents();
}

function topbar() {
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">鱼</div>
        <div><small>FISH CONTROL</small><strong>多鱼控制台</strong></div>
      </div>
      <nav class="main-nav" aria-label="主导航">
        ${["manual", "vision", "settings"].map((page) => `
          <button data-page="${page}" class="${state.page === page ? "active" : ""}">
            ${page === "manual" ? "手动控制" : page === "vision" ? "视觉控制" : "系统设置"}
          </button>
        `).join("")}
      </nav>
      <div class="top-actions">
        <span class="connection"><i class="dot"></i>服务器在线</span>
        <label class="demo-role">演示身份
          <select data-role>
            <option value="Admin" ${isAdmin() ? "selected" : ""}>管理员</option>
            <option value="User" ${!isAdmin() ? "selected" : ""}>普通用户</option>
          </select>
        </label>
        <span class="user">${isAdmin() ? "管理员" : "普通用户"} <strong>${isAdmin() ? "chenfukun" : "operator"}</strong></span>
        ${isAdmin() ? '<button class="stop-all" data-action="stop-all">全部停止</button>' : ""}
      </div>
    </header>
  `;
}

function deviceRail() {
  return `
    <aside class="device-rail">
      <div class="rail-header">
        <span class="section-kicker">${state.page === "vision" ? "VISION TARGETS" : "DEVICES"}</span>
        <span class="device-count">${devices.filter((d) => d.online).length} 在线</span>
        <h2>设备列表</h2>
        <p>${state.page === "vision" ? "选择设备作为视觉控制目标。" : "固定注册顺序，不随状态变化重排。"}</p>
      </div>
      <div class="device-list">
        ${devices.map((device) => `
          <button class="device-row ${device.id === state.selectedId ? "active" : ""} ${device.online ? "" : "offline"}" data-device="${device.id}" ${device.online ? "" : "disabled"}>
            <i class="signal ${device.online ? "" : "offline"}"></i>
            <span><strong class="device-name">${device.name}</strong><small class="device-id">${device.id} · ${device.ip}</small></span>
            <span class="device-state">${device.online ? (state.page === "vision" && device.id === state.selectedId ? "目标" : state.page === "manual" ? leaseSummary(device).label : modeLabels[device.mode]) : "离线"}</span>
          </button>
        `).join("")}
      </div>
      <div class="rail-summary">
        <strong>列表状态</strong><br />
        设备列表只接受状态更新，不接受排序更新。离线设备保留在原位置。
      </div>
    </aside>
  `;
}

function monitor() {
  const target1 = visionTargets[0];
  const target2 = visionTargets[1];
  const target3 = visionTargets[2];
  return `
    <section class="monitor" aria-label="视频监看演示">
      <span class="monitor-label">${state.page === "vision" ? "VISION / YOLO OVERLAY" : "LIVE MONITOR"} · 1920×1080</span>
      <div class="fish-track"></div>
      <div class="target one ${state.page === "vision" && state.visionTrackId === target1.trackId ? "selected" : ""}" style="--target-color:${target1.colorHex}">目标 #${target1.trackId}<br /><small>${target1.confidence}% · ${state.visionTrackId === target1.trackId ? "当前目标" : "候选"}</small></div>
      <div class="target two ${state.page === "vision" && state.visionTrackId === target2.trackId ? "selected" : ""}" style="--target-color:${target2.colorHex}">目标 #${target2.trackId}<br /><small>${target2.confidence}% · ${state.visionTrackId === target2.trackId ? "当前目标" : "候选"}</small></div>
      <div class="target three ${state.page === "vision" && state.visionTrackId === target3.trackId ? "selected" : ""}" style="--target-color:${target3.colorHex}">目标 #${target3.trackId}<br /><small>${target3.confidence}% · ${state.visionTrackId === target3.trackId ? "当前目标" : "候选"}</small></div>
      <span class="monitor-meta">CAM 01 · 30 FPS<br />延迟 42 ms<br />${state.page === "vision" ? "路径叠加 ON" : "识别叠加 OFF"}</span>
    </section>
  `;
}

function stage() {
  const device = selectedDevice();
  return `
    <main class="main-stage">
      <div class="stage-toolbar">
        <div>
          <span class="section-kicker">${state.page === "vision" ? "VISION WORKSPACE" : "MANUAL WORKSPACE"}</span>
          <h1>${state.page === "vision" ? "视觉识别与控制" : "手动驾驶"}</h1>
          <p>${device.name} · ${device.id} · 当前来源 ${device.source}</p>
        </div>
        <div class="toolbar-status">
          <span class="status-chip good"><i class="dot"></i>设备在线</span>
          <span class="status-chip ${state.page === "vision" ? "warn" : ""}">${state.page === "vision" ? "YOLO 运行中" : "键盘控制就绪"}</span>
        </div>
      </div>
      ${monitor()}
      <div class="command-strip">
        <div><strong>${state.feedback}</strong><span>命令只表达控制意图，设备状态由 ESP32 反馈。</span></div>
        <div class="key-hints">
          ${["W", "A", "S", "D"].map((key) => `<kbd class="key ${state.pressed.has(key) ? "pressed" : ""}">${key}</kbd>`).join("")}
        </div>
      </div>
    </main>
  `;
}

function inspector() {
  const device = selectedDevice();
  return `
    <aside class="inspector">
      <div class="inspector-header">
        <div><span class="section-kicker">ACTIVE DEVICE</span><h2>${device.name}</h2><p>${device.id} · ${device.ip}</p></div>
        <span class="state">${device.online ? "● 在线" : "○ 离线"}</span>
      </div>
      <section class="inspector-section">
        <h3>实时状态</h3>
        <div class="metric-grid">
          <div class="metric"><span>当前动作</span><strong>${modeLabels[device.mode]}</strong></div>
          <div class="metric"><span>控制来源</span><strong>${device.source}</strong></div>
          <div class="metric"><span>电量</span><strong>${device.battery == null ? "—" : `${device.battery}%`}</strong></div>
          <div class="metric"><span>信号</span><strong>${device.rssi == null ? "—" : `${device.rssi} dBm`}</strong></div>
        </div>
      </section>
      ${state.page === "vision" ? visionInspector() : manualInspector()}
    </aside>
  `;
}

function manualInspector() {
  const device = selectedDevice();
  const lease = leaseSummary(device);
  const canControl = lease.mine;
  return `
    <section class="inspector-section">
      <h3>运动控制</h3>
      <div class="control-pad">
        <span class="empty"></span><button data-motion="forward" class="${state.direction === "forward" ? "selected" : ""}" ${canControl ? "" : "disabled"}>前进</button><span class="empty"></span>
        <button data-motion="left" class="${state.direction === "left" ? "selected" : ""}" ${canControl ? "" : "disabled"}>左转</button><button class="stop" data-motion="stop" ${canControl ? "" : "disabled"}>停止</button><button data-motion="right" class="${state.direction === "right" ? "selected" : ""}" ${canControl ? "" : "disabled"}>右转</button>
      </div>
      <div class="range-row"><span>频率</span><input data-range="speed" type="range" min="0.3" max="5" step="0.1" value="${state.speed}" ${canControl ? "" : "disabled"} /><output>${state.speed.toFixed(1)} Hz</output></div>
      <div class="range-row"><span>摆尾幅度</span><input data-range="amplitude" type="range" min="0" max="100" step="1" value="${state.amplitude}" ${canControl ? "" : "disabled"} /><output>${state.amplitude}%</output></div>
      <div class="manual-lease-panel ${lease.className}">
        <div class="manual-lease-head"><div><span class="section-kicker">CONTROL LEASE</span><strong>控制权</strong></div><b>${lease.label}</b></div>
        <div class="manual-lease-grid">
          <div><span>控制者</span><strong>${lease.owner}</strong></div>
          <div><span>账户</span><strong>${lease.account}</strong></div>
        </div>
        ${lease.mine ? `<button class="lease-button release" data-action="release">释放当前控制权</button>` : !device?.lease ? `<button class="lease-button claim" data-action="claim">接管当前设备</button>` : `<p class="lease-note">当前设备由 ${lease.owner} 控制。你可以查看状态，但不能发送运动指令。</p>`}
      </div>
      <div class="feedback">${state.feedback}</div>
    </section>
  `;
}

function visionInspector() {
  const target = selectedVisionTarget();
  const boundDevice = devices.find((device) => device.id === state.visionBindingId);
  return `
    <section class="inspector-section">
      <h3>视觉工作流</h3>
      <div class="vision-controls">
        <label class="field">YOLO 模型
          <select data-vision="model"><option>fish-best.pt</option><option>fish-lab-v2.pt</option><option>fish-test.pt</option></select>
        </label>
        <div class="mode-switch">
          ${[["detect", "只识别"], ["assist", "辅助驾驶"], ["auto", "自动巡航"]].map(([mode, label]) => `<button data-vision-mode="${mode}" class="${state.visionMode === mode ? "active" : ""}">${label}</button>`).join("")}
        </div>
        <section class="vision-targets">
          <header><strong>识别目标 · ${visionTargets.length}</strong><span>${target ? `当前目标 #${target.trackId}` : "未锁定"}</span></header>
          <small class="vision-target-hint">识别错了时，点击正确的目标编号，再确认绑定。</small>
          ${visionTargets.map((item) => `
            <button type="button" class="vision-target-row ${item.trackId === state.visionTrackId ? "selected" : ""}" data-target-track="${item.trackId}" aria-pressed="${item.trackId === state.visionTrackId}">
              <i style="background:${item.colorHex}"></i>
              <span><b>目标 #${item.trackId}</b><small>${item.color} · ${item.confidence}% · ${item.position}</small></span>
              <strong>${item.trackId === state.visionTrackId ? "当前目标" : "选择"}</strong>
            </button>
          `).join("")}
          ${target ? `<p class="vision-target-binding found">已选择目标 #${target.trackId}。${boundDevice ? `当前绑定：${boundDevice.name}（${boundDevice.id}）。` : "尚未绑定物理设备。"}</p>` : ""}
        </section>
        <label class="field">绑定物理设备
          <select data-vision-binding>
            <option value="">不绑定（只识别）</option>
            ${devices.filter((device) => device.online).map((device) => `<option value="${device.id}" ${device.id === state.visionBindingId ? "selected" : ""}>${device.name} · ${device.id}</option>`).join("")}
          </select>
        </label>
        <button class="primary" data-action="bind-vision">${state.visionBindingId ? "确认绑定并切换目标" : "保存目标选择"}</button>
        <div class="metric-grid">
          <div class="metric"><span>检测目标</span><strong>${visionTargets.length}</strong></div>
          <div class="metric"><span>物理设备</span><strong>${boundDevice ? boundDevice.name : "未绑定"}</strong></div>
        </div>
        <button class="primary" data-action="vision-toggle">${state.visionControlActive ? "暂停视觉控制" : "启动辅助控制"}</button>
        <div class="feedback">${state.visionControlActive ? `正在控制 ${boundDevice?.name || "未绑定设备"}` : "未启动控制；可以继续更换识别目标。"}</div>
        <div class="feedback">${state.feedback}</div>
      </div>
    </section>
  `;
}

function workspaceView() {
  return `${topbar()}<div class="workspace">${deviceRail()}${stage()}${inspector()}</div>${footer()}`;
}

function settingsView() {
  const tabs = isAdmin()
    ? [["account", "账户管理"], ["devices", "设备与状态"], ["servo", "舵机标定"], ["rgb", "RGB 灯光"], ["ota", "固件与 OTA"]]
    : [["profile", "我的账户"], ["devices", "设备状态"], ["servo", "舵机标定"], ["rgb", "RGB 灯光"]];
  if (!tabs.some(([id]) => id === state.settingsTab)) state.settingsTab = tabs[0][0];
  const activeTab = state.settingsTab;
  const tabTitle = tabs.find(([id]) => id === activeTab)?.[1] || tabs[0][1];
  const accountRows = accounts.map((account) => `
    <div class="account-row">
      <div><strong>${account.name}</strong><small>${account.email}</small></div>
      <span class="role-badge ${account.role === "Admin" ? "admin" : ""}">${roleLabel(account.role)}</span>
      <span class="account-status" data-status="${account.status}">${account.status}</span>
      <span class="account-last-login">${account.lastLogin}</span>
      <div class="account-actions">
        ${account.role === "Admin" ? '<span class="account-readonly">仅管理员可见</span>' : `
          <button class="quiet" data-account-action="toggle-status" data-account-id="${account.id}">${account.status === "启用" ? "停用" : "启用"}</button>
          <button class="quiet" data-account-action="reset-password" data-account-id="${account.id}">重置密码</button>
        `}
      </div>
    </div>
  `).join("");
  const adminContent = {
    account: `
      <section class="settings-block full"><div class="settings-block-heading"><h3>账户列表</h3><span>${accounts.filter((account) => account.role === "Admin").length} 管理员 · ${accounts.filter((account) => account.role === "User").length} 普通用户</span></div>
        <p class="settings-note">这里只显示公开账户资料。管理员可以修改普通用户、停用账户或重置密码，不能读取密码明文。</p>
        <div class="account-list">${accountRows}</div>
      </section>
      <section class="settings-block"><h3>新建账户</h3><div class="demo-form">
        <label class="field">姓名<input data-new-account="name" value="${state.accountDraft.name}" placeholder="普通用户姓名" /></label>
        <label class="field">邮箱<input data-new-account="email" value="${state.accountDraft.email}" placeholder="user@example.com" /></label>
        <label class="field">账户类型<select data-new-account="role">
          <option value="User" ${state.accountDraft.role === "User" ? "selected" : ""}>普通用户</option>
          <option value="Admin" ${state.accountDraft.role === "Admin" ? "selected" : ""}>管理员</option>
        </select></label>
        <button class="primary" data-create-account>创建账户</button>
      </div></section>
      <section class="settings-block"><h3>管理员权限</h3><p>账户管理、设备运维、固件 OTA、RGB 和舵机标定。管理员不能查看任何账户的密码。</p></section>
    `,
    devices: `
      <section class="settings-block"><h3>设备状态总览</h3><p>在线设备 ${devices.filter((device) => device.online).length}/${devices.length}<br />当前设备 ${selectedDevice().name}<br />协议 Fish Protocol v2</p></section>
      <section class="settings-block"><h3>运行状态</h3><p>状态源：ESP32<br />设备列表：注册顺序<br />ACK 延迟：42 ms</p></section>
    `,
    servo: `<section class="settings-block full"><h3>舵机标定</h3><p>管理员工作区：设置中位、最小角度和最大角度，并保存到设备 NVS。</p></section>`,
    rgb: `<section class="settings-block full"><h3>RGB 灯光</h3><p>管理员工作区：设置灯珠色序、颜色和亮度。</p></section>`,
    ota: `<section class="settings-block full"><h3>固件与 OTA</h3><p>管理员工作区：上传固件、校验 SHA-256，并选择设备执行 OTA。</p></section>`,
  };
  const userContent = {
    profile: `
      <section class="settings-block"><h3>个人资料</h3><p>姓名：实验员<br />邮箱：operator@example.com<br />账户类型：普通用户</p></section>
      <section class="settings-block"><h3>密码安全</h3><p>系统只保存密码摘要。管理员不能读取密码明文，需要时只能执行重置。</p></section>
      <section class="settings-block full"><h3>普通用户可用功能</h3><p>手动控制、视觉识别、设备在线状态和个人运动参数。账户管理、OTA、RGB 和舵机标定由管理员处理。</p></section>
    `,
    devices: `
      <section class="settings-block"><h3>设备状态</h3><p>在线设备 ${devices.filter((device) => device.online).length}/${devices.length}<br />当前设备 ${selectedDevice().name}<br />可查看实时状态。</p></section>
      <section class="settings-block"><h3>控制权限</h3><p>普通用户可以申请设备控制权。每条鱼同一时间只有一个控制者。</p></section>
    `,
    servo: `<section class="settings-block full"><h3>舵机标定</h3><p>普通用户可以调整当前设备的舵机中位和运动参数，保存后由设备反馈实际状态。</p></section>`,
    rgb: `<section class="settings-block full"><h3>RGB 灯光</h3><p>普通用户可以调整设备状态灯的颜色、亮度和灯珠色序。固件和 OTA 操作仍由管理员负责。</p></section>`,
  };
  return `${topbar()}
    <div class="settings-page">
      <nav class="settings-nav">${tabs.map(([id, label]) => `<button data-settings="${id}" class="${state.settingsTab === id ? "active" : ""}">${label}</button>`).join("")}</nav>
      <main class="settings-content">
        <span class="section-kicker">SYSTEM SETTINGS</span>
        <h1>${tabTitle}</h1>
        <p>${isAdmin() ? "管理员工作区：账户处理、设备运维和固件升级。" : "普通用户工作区：账户、设备状态、舵机和 RGB 参数。"}</p>
        <div class="settings-form">
          ${(isAdmin() ? adminContent : userContent)[activeTab]}
        </div>
      </main>
    </div>${footer()}`;
}

function footer() {
  return `<footer class="footer"><span><strong>Fish Protocol v2</strong> · Desktop Console Demo</span><span>状态源：ESP32 · 列表顺序：注册顺序</span></footer>`;
}

function bindEvents() {
  document.querySelector("[data-role]")?.addEventListener("change", (event) => {
    state.role = event.target.value;
    if (!isAdmin() && state.settingsTab !== "devices") state.settingsTab = "profile";
    state.feedback = `${roleLabel()}界面已切换，设置项已按权限重新显示。`;
    app();
  });
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => {
    state.page = button.dataset.page;
    state.feedback = state.page === "vision" ? "视觉工作区已打开，当前只识别不接管设备。" : state.page === "settings" ? "设置工作区已打开。" : "手动工作区已打开，键盘控制就绪。";
    app();
  }));
  document.querySelectorAll("[data-device]").forEach((button) => button.addEventListener("click", () => {
    state.selectedId = button.dataset.device;
    const selected = selectedDevice();
    const lease = leaseSummary(selected);
    state.feedback = lease.mine
      ? `${selected.name} 是你的当前控制设备。`
      : lease.className === "other"
        ? `${selected.name} 当前由 ${lease.owner} 控制，只读查看。`
        : `${selected.name} 当前空闲，可在右侧接管。`;
    app();
  }));
  document.querySelectorAll("[data-action='claim']").forEach((button) => button.addEventListener("click", () => {
    const device = selectedDevice();
    if (!device?.online) return;
    devices.forEach((item) => {
      if (item.id !== device.id && leaseIsMine(item)) {
        item.lease = null;
        item.mode = "stop";
        item.source = "system";
      }
    });
    device.lease = { ownerId: currentAccount().id, ownerName: currentAccount().name, ownerEmail: currentAccount().email, mode: "manual", expiresAt: "2026-09-03T10:30:00+08:00" };
    state.feedback = `已接管 ${device.name}。控制权由 ${currentAccount().name} 持有。`;
    app();
  }));
  document.querySelectorAll("[data-action='release']").forEach((button) => button.addEventListener("click", () => {
    const device = selectedDevice();
    if (!leaseIsMine(device)) return;
    device.lease = null;
    device.mode = "stop";
    device.source = "system";
    state.direction = "stop";
    state.pressed.clear();
    state.feedback = `${device.name} 已停止，控制权已释放，现在处于空闲状态。`;
    app();
  }));
  document.querySelectorAll("[data-motion]").forEach((button) => button.addEventListener("click", () => {
    state.direction = button.dataset.motion;
    const device = selectedDevice();
    if (!leaseIsMine(device)) {
      state.feedback = `${device.name} 当前没有你的控制权，不能发送运动指令。`;
      app();
      return;
    }
    device.mode = state.direction;
    device.source = "manual";
    state.feedback = `${device.name} 已发送 ${modeLabels[state.direction]} 意图，等待设备 ACK。`;
    app();
  }));
  document.querySelectorAll("[data-range]").forEach((input) => input.addEventListener("input", () => {
    state[input.dataset.range] = Number(input.value);
    state.feedback = "运动参数已更新，下一条实时命令将携带完整参数。";
    app();
  }));
  document.querySelectorAll("[data-vision-mode]").forEach((button) => button.addEventListener("click", () => {
    state.visionMode = button.dataset.visionMode;
    state.feedback = `视觉模式已切换为 ${button.textContent}。`;
    app();
  }));
  document.querySelectorAll("[data-target-track]").forEach((button) => button.addEventListener("click", () => {
    state.visionTrackId = Number(button.dataset.targetTrack);
    state.visionControlActive = false;
    state.feedback = `已选择目标 #${state.visionTrackId}。请检查画面位置，并确认对应物理设备。`;
    app();
  }));
  document.querySelector("[data-vision-binding]")?.addEventListener("change", (event) => {
    state.visionBindingId = event.target.value;
    state.visionControlActive = false;
    state.feedback = state.visionBindingId
      ? "设备绑定已修改，请点击确认绑定并切换目标。"
      : "已取消物理设备绑定，仅保留视觉识别。";
  });
  document.querySelectorAll("[data-settings]").forEach((button) => button.addEventListener("click", () => {
    state.settingsTab = button.dataset.settings;
    app();
  }));
  document.querySelectorAll("[data-account-action]").forEach((button) => button.addEventListener("click", () => {
    const account = accounts.find((item) => item.id === button.dataset.accountId);
    if (!account) return;
    if (button.dataset.accountAction === "toggle-status") {
      account.status = account.status === "启用" ? "停用" : "启用";
      state.feedback = `${account.name} 已${account.status}，账户列表保持原有顺序。`;
    } else {
      state.feedback = `已为 ${account.name} 创建重置密码请求，演示不会显示密码明文。`;
    }
    app();
  }));
  document.querySelectorAll("[data-new-account]").forEach((input) => {
    const eventName = input.tagName === "SELECT" ? "change" : "input";
    input.addEventListener(eventName, () => {
      state.accountDraft[input.dataset.newAccount] = input.value;
    });
  });
  document.querySelector("[data-create-account]")?.addEventListener("click", () => {
    const draft = state.accountDraft;
    if (!draft.name.trim() || !draft.email.trim()) {
      state.feedback = "请先填写姓名和邮箱，再创建账户。";
      app();
      return;
    }
    accounts.push({
      id: `user-${Date.now()}`,
      name: draft.name.trim(),
      email: draft.email.trim(),
      role: draft.role,
      status: "启用",
      lastLogin: "尚未登录",
    });
    state.accountDraft = { name: "", email: "", role: "User" };
    state.feedback = `已创建${roleLabel(draft.role)}账户 ${draft.email.trim()}。`;
    app();
  });
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.action === "stop-all") {
      devices.forEach((device) => { if (device.online) { device.mode = "stop"; device.source = "system"; } });
      state.direction = "stop";
      state.feedback = "ALL STOP 已发送，等待所有在线设备确认。";
      app();
    }
    if (button.dataset.action === "vision-toggle") {
      if (!state.visionBindingId) {
        state.feedback = "请先选择目标并绑定物理设备，再启动视觉控制。";
        app();
        return;
      }
      state.visionControlActive = !state.visionControlActive;
      state.feedback = state.visionControlActive
        ? `已启动 ${devices.find((device) => device.id === state.visionBindingId)?.name || state.visionBindingId} 的视觉控制。`
        : "视觉控制已暂停，当前目标仍保留。";
      app();
    }
    if (button.dataset.action === "bind-vision") {
      const target = selectedVisionTarget();
      const device = devices.find((item) => item.id === state.visionBindingId);
      if (!target || !device) {
        state.feedback = "请先选择识别目标和在线物理设备。";
        app();
        return;
      }
      state.visionControlActive = false;
      devices.forEach((item) => {
        if (item.id !== device.id && item.source === "vision") item.source = "idle";
      });
      target.deviceId = device.id;
      device.source = "vision";
      state.selectedId = device.id;
      state.feedback = `已将目标 #${target.trackId} 重新绑定到 ${device.name}。旧视觉控制已停止，请确认后再启动。`;
      app();
    }
  }));
}

window.addEventListener("keydown", (event) => {
  if (!["w", "a", "s", "d"].includes(event.key.toLowerCase())) return;
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName)) return;
  event.preventDefault();
  const key = event.key.toUpperCase();
  if (state.pressed.has(key)) return;
  state.pressed.add(key);
  applyKeyboardDirection();
  app();
});

window.addEventListener("keyup", (event) => {
  if (!["w", "a", "s", "d"].includes(event.key.toLowerCase())) return;
  const key = event.key.toUpperCase();
  if (!state.pressed.has(key)) return;
  state.pressed.delete(key);
  applyKeyboardDirection();
  if (state.page === "manual" && state.direction === "forward") {
    state.feedback = "转弯已释放，仍保持前进意图。";
  }
  app();
});

app();
