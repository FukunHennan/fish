import { useEffect, useMemo, useRef, useState } from "react";
import {
  competitionApi,
  competitionStateLabel,
  formatCompetitionClock,
} from "./competitionApi.js";
import CompetitionVideoPanel from "./CompetitionVideoPanel.jsx";

const pages = [
  { id: "lobby", label: "比赛大厅", icon: "home", ratio: "1685 / 934", ratioValue: 1.8041 },
  { id: "control", label: "操控台", icon: "pad", ratio: "1672 / 940", ratioValue: 1.7787 },
  { id: "missions", label: "自主任务", icon: "flag", ratio: "1682 / 935", ratioValue: 1.7989 },
  { id: "records", label: "比赛记录", icon: "chart", ratio: "1674 / 940", ratioValue: 1.7809 },
];

const resources = [
  ["资源 #1", "blue", 38, 41],
  ["资源 #2", "yellow", 58, 36],
  ["资源 #3", "green", 31, 61],
  ["资源 #4", "purple", 66, 59],
  ["资源 #5", "red-dot", 42, 75],
  ["资源 #6", "black", 62, 74],
];

const taskList = [
  ["智能走迷宫", "在复杂水下迷宫中自主规划路径", "maze"],
  ["定点巡航", "按顺序到达多个指定点位完成巡航任务", "pin"],
  ["多鱼跟随 · 8字形", "三条机器鱼协同跟随完成轨迹运动", "fish"],
  ["自主水上足球", "自主识别目标，制定进攻策略并实现协同", "ball"],
];

const validPageIds = new Set(pages.map((item) => item.id));

const EMPTY_MATCH = {
  matchNo: "暂无比赛",
  group: "未设置组别",
  venue: "未设置赛场",
  state: "waiting",
  blue: { side: "blue", name: "蓝队", score: 0, players: [] },
  red: { side: "red", name: "红队", score: 0, players: [] },
  elapsedMs: 0,
};

function normalizeMatch(match) {
  if (!match) return null;
  return {
    ...EMPTY_MATCH,
    ...match,
    blue: { ...EMPTY_MATCH.blue, ...(match.blue || {}) },
    red: { ...EMPTY_MATCH.red, ...(match.red || {}) },
  };
}

function playerForSlot(team, slot) {
  return team?.players?.find((player) => String(player.slot).toUpperCase() === slot) || {
    slot,
    name: "",
    signedIn: false,
    deviceId: "",
  };
}

function deviceLabel(device) {
  return device?.name || device?.deviceId || "未分配";
}

function formatRecordTime(value) {
  if (!value) return "未记录时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function normalizeLoginAccount(value) {
  const account = String(value || "").trim();
  if (!account || account.includes("@")) return account;
  return `${account}@fish.local`;
}

function pageFromHash() {
  const id = window.location.hash.replace(/^#/, "");
  return validPageIds.has(id) ? id : "lobby";
}

function LoginGate({ onLogin, busy, error }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(event) {
    event.preventDefault();
    onLogin(normalizeLoginAccount(email), password);
  }

  return (
    <main className="competitionLogin">
      <form className="competitionLoginCard" onSubmit={submit}>
        <FishLogo />
        <p className="eyebrow">FISH CONTROL / COMPETITION</p>
        <h1>登录赛事端</h1>
        <p>请使用赛事账号登录，比赛状态和裁判操作将由后端统一保存。</p>
        <label><span>账号</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" placeholder="请输入账号或邮箱" /></label>
        <label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="请输入密码" /></label>
        {error && <div className="competitionLoginError">{error}</div>}
        <button className="loginButton" type="submit" disabled={busy}>{busy ? "登录中…" : "进入赛事端"}</button>
      </form>
    </main>
  );
}

function DockNav({ page, onPageChange }) {
  const navRef = useRef(null);
  const reduceMotion = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches, []);

  function updateDock(event) {
    if (reduceMotion) return;
    const items = navRef.current?.querySelectorAll(".dockItem") || [];
    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
      const influence = Math.max(0, 1 - distance / 180);
      const eased = influence * influence * (3 - 2 * influence);
      item.style.setProperty("--dock-scale", String((1 + eased * 0.18).toFixed(3)));
      item.style.setProperty("--dock-lift", `${(-eased * 8).toFixed(1)}px`);
    });
  }

  function resetDock() {
    const items = navRef.current?.querySelectorAll(".dockItem") || [];
    items.forEach((item) => {
      item.style.setProperty("--dock-scale", "1");
      item.style.setProperty("--dock-lift", "0px");
    });
  }

  return (
    <nav className="dockNav" ref={navRef} onMouseMove={updateDock} onMouseLeave={resetDock} aria-label="赛事端导航">
      {pages.map((item) => (
        <button
          className={`dockItem ${page === item.id ? "active" : ""}`}
          type="button"
          key={item.id}
          aria-current={page === item.id ? "page" : undefined}
          onClick={() => onPageChange(item.id)}
        >
          <span className={`dockIcon ${item.icon}`} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function FishLogo() {
  return <span className="fishLogo" aria-hidden="true"><i /></span>;
}

function Header({ page, onPageChange, user, backendStatus, onLogout }) {
  return (
    <header className="competitionHeader">
      <section className="brandBlock">
        <FishLogo />
        <div>
          <h1>FISH <span>CONTROL</span> 学生赛事端</h1>
          <p>水下机器鱼 2v2 生态科技赛</p>
        </div>
      </section>
      <DockNav page={page} onPageChange={onPageChange} />
      <div className="headerMeta">
        <p className="headerSlogan">{page === "control" ? "科技让水中运动更精彩" : "科技 · 协作 · 挑战 · 成长"}</p>
        <span className={`backendBadge ${backendStatus === "online" ? "online" : "offline"}`}>
          <i />{backendStatus === "online" ? "后端已接入" : "后端连接中"}
        </span>
        {user?.id === "local-anonymous"
          ? <span className="userBadge">本地开发</span>
          : user && <button className="userBadge" type="button" onClick={onLogout} title="退出登录">{user.name || user.email} · 退出</button>}
      </div>
    </header>
  );
}

function StatusTile({ label, value, tone = "cyan" }) {
  return (
    <section className={`statusTile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function ControlPool({ compact = false, mission = false }) {
  return (
    <div className={`poolStage ${compact ? "compact" : ""} ${mission ? "mission" : ""}`}>
      <div className="poolWater" />
      <div className="poolCaustics" />
      <div className="poolGrid" />
      {mission && (
        <>
          <span className="poolAxis x">X (m)</span>
          <span className="poolAxis y">Y (m)</span>
        </>
      )}
      <div className="baseZone blue">蓝队基地</div>
      <div className="baseZone red">红队基地</div>
      {mission ? (
        <>
          <div className="figureTrack main" />
          <div className="figureTrack yellow" />
          <div className="figureTrack red" />
          <span className="fishMarker blue leader" style={{ left: "67%", top: "34%" }} data-label="蓝色 · 领航" />
          <span className="fishMarker yellow" style={{ left: "23%", top: "40%" }} data-label="黄色 · 跟随" />
          <span className="fishMarker red" style={{ left: "38%", top: "58%" }} data-label="红色 · 跟随" />
        </>
      ) : (
        <>
          <span className="fishMarker blue" style={{ left: "24%", top: "38%" }} data-label="B1" />
          <span className="fishMarker blue" style={{ left: "23%", top: "78%" }} data-label="B2" />
          <span className="fishMarker red" style={{ left: "79%", top: "40%" }} data-label="R1" />
          <span className="fishMarker red" style={{ left: "78%", top: "78%" }} data-label="R2" />
          {resources.map(([label, tone, left, top]) => (
            <span className={`resourceMarker ${tone}`} data-label={label} style={{ left: `${left}%`, top: `${top}%` }} key={label} />
          ))}
          <span className="ecoPoint a">生态修复点 A</span>
          <span className="handoffPoint">协同交付点</span>
          <span className="ecoPoint b">生态修复点 B</span>
        </>
      )}
    </div>
  );
}

function LobbyPage({ onPageChange, match, devices, records: recordList }) {
  const onlineCount = devices.filter((device) => device.online).length;
  const assignedCount = devices.filter((device) => device.assignedTo).length;
  const currentMatch = match || EMPTY_MATCH;
  return (
    <section className="screen lobbyScreen">
      <aside className="spacePanel glassCard hoverCard">
        <header><h2>我的空间</h2><button type="button">›</button></header>
        <div className="teamBadge"><FishLogo /></div>
        <h3>{currentMatch.blue.name || "蓝队"}</h3>
        <p>{currentMatch.matchNo || "暂无比赛"}<br />{currentMatch.group || "赛事数据由后端同步"}</p>
        <div className="deviceStatus"><i />已连接设备 {onlineCount} 台 · 已分配 {assignedCount} 台</div>
        <button className="outlineButton" type="button">管理我的设备</button>
        <small>更聪明的鱼<br />守护更美的海</small>
      </aside>

      <main className="lobbyHero glassCard hoverCard">
        <div className="waterBeam" />
        <h2>从一个任务开始</h2>
        <p>在这里，开启你的海洋科技探索之旅</p>
        <div className="heroCards">
          <article className="heroCard hoverCard">
            <span className="heroIcon trophy" />
            <h3>赛事任务</h3>
            <p>进入已分配的赛事任务</p>
            <b>有 1 个待开始任务</b>
            <button type="button" onClick={() => onPageChange("missions")}>查看任务</button>
          </article>
          <article className="heroCard hoverCard">
            <span className="heroIcon compass" />
            <h3>训练入口</h3>
            <p>练习操控、路径规划与多鱼协同</p>
            <button type="button" onClick={() => onPageChange("control")}>开始训练</button>
          </article>
          <article className="heroCard hoverCard">
            <span className="heroIcon link" />
            <h3>连接设备</h3>
            <p>连接机器鱼并检查视觉状态</p>
            <button type="button">连接设备</button>
          </article>
        </div>
      </main>

      <aside className="lobbyStatus">
        <section className="glassCard hoverCard">
          <h2>当前状态</h2>
          <div className="statusList">
            <StatusTile label="赛事任务" value={competitionStateLabel(currentMatch.state)} tone="orange" />
            <StatusTile label="比赛记录" value={`${recordList.length} 场`} />
            <StatusTile label="设备连接" value={`${onlineCount} 台在线`} tone="green" />
            <StatusTile label="系统状态" value="后端正常" tone="green" />
          </div>
        </section>
        <section className="continuePanel glassCard hoverCard">
          <h2>最近继续</h2>
          <div>
            <span className="docIcon" />
            <p><strong>自主训练</strong><small>上次训练进度</small></p>
            <button type="button" onClick={() => onPageChange("control")}>继续</button>
          </div>
        </section>
      </aside>

      <section className="quickPanel glassCard hoverCard">
        <header><h2>快速训练</h2><button type="button">更多训练 ›</button></header>
        <div className="trainingCards">
          {["视觉手动操控", "智能走迷宫", "多鱼跟随（8字形）"].map((title, index) => (
            <button type="button" className="trainingCard hoverCard" key={title}>
              <span className={`trainingImage t${index}`} />
              <strong>{title}</strong>
              <small>{index === 0 ? "熟悉基础操控，提升控制能力" : index === 1 ? "基于视觉的路径规划训练" : "练习多鱼协同与编队控制"}</small>
              <i>›</i>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function MatchHud({ match, elapsedMs, onAction, busy }) {
  const current = match || EMPTY_MATCH;
  const isRunning = current.state === "running";
  const isFinished = current.state === "finished";
  return (
    <section className="matchHud">
      <div className="hudTop">
        <div className="hudTitle">
          <h2>{current.matchNo} · {current.group || "学生组"}</h2>
          <p>{current.venue || "未设置赛场"} · {current.blue.name || "蓝队"} vs {current.red.name || "红队"}</p>
        </div>
        <div className="hudScore"><span>本局积分</span><b className="blue">{current.blue.score}</b><em>:</em><b className="red">{current.red.score}</b></div>
        <StatusTile label="比赛用时" value={formatCompetitionClock(elapsedMs)} />
        <StatusTile label="比赛状态" value={competitionStateLabel(current.state)} tone={isRunning ? "green" : "orange"} />
        <button type="button" className="visionBadge" onClick={() => onAction("clock", { action: isRunning ? "pause" : "start" })} disabled={busy || isFinished}>{isRunning ? "暂停比赛" : "开始比赛"}</button>
        <button type="button" className="stopButton" onClick={() => onAction("finish")} disabled={busy || isFinished}>结束比赛</button>
      </div>
      <div className="phaseRail" aria-label="比赛准备进度">
        <span className={current.blue.players?.every((player) => player.signedIn) ? "done" : ""}>蓝队签到</span>
        <span className={current.red.players?.every((player) => player.signedIn) ? "done" : ""}>红队签到</span>
        <span className={isRunning ? "active" : ""}>{competitionStateLabel(current.state)}</span>
        <button type="button" onClick={() => onAction("score", { side: "blue", delta: 1 })} disabled={busy || isFinished}>蓝队 +1</button>
        <button type="button" onClick={() => onAction("score", { side: "red", delta: 1 })} disabled={busy || isFinished}>红队 +1</button>
      </div>
    </section>
  );
}

function DeviceAssignment({ team, slot, devices, onAssign, busy }) {
  const player = playerForSlot(team, slot);
  const availableDevices = devices.filter((device) => device.online);
  return (
    <label className="deviceAssignment">
      <span>{slot} · {player.name || "待签到"}</span>
      <select
        value={player.deviceId || ""}
        disabled={busy}
        onChange={(event) => onAssign(team.side, slot, event.target.value)}
      >
        <option value="">未分配机器鱼</option>
        {availableDevices.map((device) => {
          const assignment = device.assignedTo ? ` · 当前 ${device.assignedTo}` : " · 未分配";
          return <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device)}{assignment}</option>;
        })}
      </select>
    </label>
  );
}

function ControlPage({ match, elapsedMs, devices, onAction, busy }) {
  const current = match || EMPTY_MATCH;
  const b1 = playerForSlot(current.blue, "B1");
  const b2 = playerForSlot(current.blue, "B2");
  return (
    <section className="screen controlScreen">
      <MatchHud match={current} elapsedMs={elapsedMs} onAction={onAction} busy={busy} />
      <aside className="controlRail glassCard hoverCard">
        <header><h2>我的控制</h2><span>专注操控 · 为团队而战</span></header>
        <article className="controlFish">
          <span className="fishChip" />
          <div><h3>B1</h3><p>{b1.name || "蓝队选手"}</p></div>
          <b>{b1.deviceId ? "已分配" : "待分配"}</b>
        </article>
        <div className="telemetryGrid">
          <StatusTile label="设备" value={b1.deviceId ? deviceLabel(devices.find((device) => device.deviceId === b1.deviceId)) : "未绑定"} tone={b1.deviceId ? "green" : "orange"} />
          <StatusTile label="在线机器鱼" value={`${devices.filter((device) => device.online).length} 台`} />
          <StatusTile label="比赛状态" value={competitionStateLabel(current.state)} tone={current.state === "running" ? "green" : "orange"} />
          <StatusTile label="蓝队签到" value={`${current.blue.players?.filter((player) => player.signedIn).length || 0}/${current.blue.players?.length || 2}`} />
          <StatusTile label="红队签到" value={`${current.red.players?.filter((player) => player.signedIn).length || 0}/${current.red.players?.length || 2}`} />
          <StatusTile label="场地" value={current.venue || "未设置"} />
        </div>
        <section className="assignmentPanel">
          <h3>机器鱼席位</h3>
          <DeviceAssignment team={current.blue} slot="B1" devices={devices} onAssign={(side, slot, deviceId) => onAction(deviceId ? "assign" : "unassign", { side, slot, ...(deviceId ? { deviceId } : {}) })} busy={busy} />
          <DeviceAssignment team={current.blue} slot="B2" devices={devices} onAssign={(side, slot, deviceId) => onAction(deviceId ? "assign" : "unassign", { side, slot, ...(deviceId ? { deviceId } : {}) })} busy={busy} />
          <DeviceAssignment team={current.red} slot="R1" devices={devices} onAssign={(side, slot, deviceId) => onAction(deviceId ? "assign" : "unassign", { side, slot, ...(deviceId ? { deviceId } : {}) })} busy={busy} />
          <DeviceAssignment team={current.red} slot="R2" devices={devices} onAssign={(side, slot, deviceId) => onAction(deviceId ? "assign" : "unassign", { side, slot, ...(deviceId ? { deviceId } : {}) })} busy={busy} />
        </section>
        <div className="wasdPad">
          <button type="button" className="forward" disabled={!b1.deviceId || current.state !== "running"}>W<span>前进</span></button>
          <button type="button" disabled={!b1.deviceId || current.state !== "running"}>A<span>左转</span></button>
          <button type="button" disabled={!b1.deviceId || current.state !== "running"}>D<span>右转</span></button>
          <button type="button" className="space" onClick={() => onAction("clock", { action: "pause" })} disabled={busy || current.state !== "running"}>SPACE<span>紧急停止</span></button>
        </div>
        <section className="railStatus">
          <h3>队友状态</h3>
          <p><span>B2</span><b>{b2.name || "待签到"}</b><em>{b2.deviceId ? deviceLabel(devices.find((device) => device.deviceId === b2.deviceId)) : "未分配机器鱼"}</em></p>
        </section>
      </aside>

      <main className="fieldPanel glassCard hoverCard">
        <CompetitionVideoPanel />
        <footer><span>水池尺寸：6.0m × 4.0m</span><span>{current.matchNo} · {competitionStateLabel(current.state)}</span></footer>
      </main>

      <aside className="tacticsPanel">
        <section className="glassCard hoverCard">
          <header><h2>比赛态势</h2><span>{current.group || "学生组"}</span></header>
          <ControlPool compact />
          <div className="sideMetricRow">
            <StatusTile label="蓝队积分" value={current.blue.score} tone="cyan" />
            <StatusTile label="红队积分" value={current.red.score} tone="red" />
          </div>
          <article className="adviceCard hoverCard"><span className="cube" /><p><b>{competitionStateLabel(current.state)}</b><small>{current.state === "ready" ? "双方签到完成，可以开始比赛" : current.state === "running" ? "比赛正在进行，操作会实时保存" : "使用上方控制按钮推进比赛流程"}</small></p><i>›</i></article>
        </section>
        <section className="glassCard hoverCard">
          <h2>快捷记分</h2>
          <div className="signalButtons">
            <button type="button" onClick={() => onAction("score", { side: "blue", delta: 1 })} disabled={busy || current.state === "finished"}>蓝队 +1</button>
            <button type="button" onClick={() => onAction("score", { side: "red", delta: 1 })} disabled={busy || current.state === "finished"}>红队 +1</button>
            <button type="button" onClick={() => onAction("clock", { action: "reset" })} disabled={busy}>重置计时</button>
          </div>
        </section>
        <section className="glassCard hoverCard">
          <h2>比赛事件</h2>
          <p className="eventLine"><span>{formatCompetitionClock(elapsedMs)}</span>{competitionStateLabel(current.state)}</p>
          <p className="eventLine"><span>{current.blue.score}:{current.red.score}</span>当前比分</p>
          <p className="eventLine"><span>{devices.filter((device) => device.online).length}</span>在线机器鱼</p>
        </section>
      </aside>
    </section>
  );
}

function MissionsPage() {
  return (
    <section className="screen missionScreen">
      <aside className="taskSelect glassCard hoverCard">
        <h2>任务选择</h2>
        <p>选择本次比赛要执行的自主任务</p>
        <div>
          {taskList.map(([title, text, icon], index) => (
            <button type="button" className={`taskCard ${index === 2 ? "selected" : ""}`} key={title}>
              <span className={`taskIcon ${icon}`} />
              <strong>{title}</strong>
              <small>{text}</small>
              <i />
            </button>
          ))}
        </div>
        <section className="requirements">
          <h3>任务要求</h3>
          <p>红、黄、蓝三条鱼</p>
          <p>蓝鱼领航，红黄跟随</p>
          <p>完成 2 轮 8 字形</p>
          <p>限时 120 秒</p>
          <p>禁止越界</p>
        </section>
      </aside>

      <main className="missionArena glassCard hoverCard">
        <header><h2>多鱼跟随 · 8 字形轨迹</h2><div><span>三鱼视觉定位在线</span><span>编队路径已验证</span></div></header>
        <ControlPool mission />
        <div className="missionStats">
          <StatusTile label="机器鱼" value="3 条" />
          <StatusTile label="轨迹" value="2 轮" />
          <StatusTile label="预计" value="48 s" />
          <StatusTile label="平均编队间距" value="0.35 m" />
        </div>
      </main>

      <aside className="strategyPanel glassCard hoverCard">
        <h2>策略与编程</h2>
        <p>通过图形化编程设计算法策略，控制机器鱼完成任务</p>
        <div className="strategyTabs"><button>路径规划</button><button className="active">图形化编程</button><button>Python（进阶）</button></div>
        <div className="blockStack">
          <div className="block purple">当 任务开始</div>
          <div className="block blue">设置蓝鱼为领航</div>
          <div className="block blue">生成 8 字形轨迹</div>
          <div className="block violet">红鱼、黄鱼跟随蓝鱼</div>
          <div className="block orange">重复执行 2 轮</div>
          <div className="block blue indent">沿 8 字形轨迹运动</div>
          <div className="block red">完成 2 轮后停止</div>
        </div>
        <div className="strategyActions">
          <button type="button">仿真运行</button>
          <button type="button">保存策略</button>
          <button type="button" className="deploy">部署到比赛场地</button>
        </div>
        <div className="evalGrid">
          <StatusTile label="红鱼间距" value="0.34 m" tone="red" />
          <StatusTile label="黄鱼间距" value="0.36 m" tone="orange" />
          <StatusTile label="轨迹偏差" value="0.08 m" />
          <StatusTile label="完成进度" value="1/2" />
        </div>
      </aside>
    </section>
  );
}

function RecordsPage({ records: recordList }) {
  const selected = recordList[0] || null;
  return (
    <section className="screen recordsScreen">
      <aside className="recordList glassCard hoverCard">
        <header><h2>任务记录</h2><button type="button">全部类型</button></header>
        {recordList.length === 0 && <p className="emptyState">暂无已结束比赛</p>}
        {recordList.map((record, index) => (
          <button type="button" className={`recordItem ${index === 0 ? "active" : ""}`} key={`${record.matchNo}-${record.finishedAt}-${index}`}>
            <span className="recordThumb" />
            <strong>{record.matchNo || "赛事对抗"}</strong>
            <small>{formatRecordTime(record.finishedAt)}</small>
            <b>{record.blueScore} : {record.redScore}</b>
            <em>{record.group || "学生组"}</em>
          </button>
        ))}
      </aside>

      <main className="replayPanel">
        <section className="recordHeader glassCard hoverCard">
          <div><h2>{selected ? selected.matchNo : "等待比赛结束"} · 比赛回放</h2><p>{selected ? `${selected.group || "学生组"} · ${selected.venue || "未设置赛场"}` : "完成一场比赛后，这里会显示后端保存的记录"}</p></div>
          <div className="winnerScore"><span>本局结果</span><strong>{selected ? `${selected.blueScore} : ${selected.redScore}` : "- : -"}</strong><b>{selected ? (selected.blueScore === selected.redScore ? "平局" : "已完成") : "暂无结果"}</b></div>
        </section>
        <section className="replayStage glassCard hoverCard">
          <header><h2>比赛视频回放</h2><select defaultValue="top"><option value="top">多视角：俯视视角</option></select></header>
          <ControlPool />
          <footer className="playbar"><button type="button" disabled={!selected}>暂停</button><span>{selected ? formatCompetitionClock(selected.elapsedMs) : "00:00"}</span><i /><select disabled={!selected}><option>1×</option></select></footer>
        </section>
        <section className="recordSummary">
          <article className="glassCard hoverCard"><h3>比赛概要</h3><p>蓝队 <b>{selected?.blueName || "-"}</b></p><p>红队 <b>{selected?.redName || "-"}</b></p><p>比赛用时 <b>{selected ? formatCompetitionClock(selected.elapsedMs) : "-"}</b></p><p>结束时间 <b>{selected ? formatRecordTime(selected.finishedAt) : "-"}</b></p></article>
          <article className="glassCard hoverCard"><h3>数据来源</h3><p>记录状态 <b>{selected ? "后端已保存" : "等待数据"}</b></p><p>比赛编号 <b>{selected?.matchNo || "-"}</b></p><p>比赛组别 <b>{selected?.group || "-"}</b></p><p>比赛场地 <b>{selected?.venue || "-"}</b></p></article>
          <article className="glassCard hoverCard"><h3>提示</h3><p>比赛记录 <b>自动同步</b></p><p>计时数据 <b>来自裁判端</b></p><p>比分数据 <b>来自赛事服务</b></p><p>设备归属 <b>按签到保存</b></p></article>
        </section>
      </main>

      <aside className="scorePanel glassCard hoverCard">
        <h2>本局积分</h2>
        <div className="scoreTiles">
          <StatusTile label="蓝队得分" value={selected?.blueScore ?? 0} />
          <StatusTile label="红队得分" value={selected?.redScore ?? 0} tone="red" />
          <StatusTile label="比赛用时" value={selected ? formatCompetitionClock(selected.elapsedMs) : "00:00"} tone="orange" />
          <StatusTile label="比赛场地" value={selected?.venue || "-"} />
        </div>
        <section className="keyEvents">
          <h3>关键事件</h3>
          <p><span>{selected ? formatRecordTime(selected.finishedAt) : "-"}</span> 比赛结束 <b>已保存</b></p>
          <p><span>{selected ? selected.blueScore : 0}</span> 蓝队最终得分 <b>-</b></p>
          <p><span>{selected ? selected.redScore : 0}</span> 红队最终得分 <b>-</b></p>
        </section>
        <button type="button" className="retryButton" disabled={!selected}>再次挑战</button>
      </aside>
    </section>
  );
}

export default function CompetitionApp() {
  const [page, setPage] = useState(pageFromHash);
  const [auth, setAuth] = useState({ loading: true, authenticated: false, user: null });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [backendStatus, setBackendStatus] = useState("connecting");
  const [apiError, setApiError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [matchPayload, setMatchPayload] = useState({ match: null, elapsedMs: 0, running: false, fetchedAt: Date.now() });
  const [recordList, setRecordList] = useState([]);
  const [devices, setDevices] = useState([]);
  const [clockNow, setClockNow] = useState(Date.now());
  const createdMatchRef = useRef(false);
  const pageConfig = pages.find((item) => item.id === page) || pages[0];

  useEffect(() => {
    let active = true;
    competitionApi.authMe()
      .then((result) => {
        if (!active) return;
        setAuth({ loading: false, authenticated: Boolean(result?.authenticated), user: result?.user || null });
      })
      .catch((error) => {
        if (!active) return;
        setAuth({ loading: false, authenticated: false, user: null });
        setAuthError(error.message || "无法连接认证服务");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!matchPayload.running) return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [matchPayload.running]);

  async function refreshCompetition({ createIfMissing = false } = {}) {
    const [nextMatch, nextRecords, nextDevices] = await Promise.all([
      competitionApi.getMatch(),
      competitionApi.getRecords(),
      competitionApi.getDevices(),
    ]);
    let matchResult = nextMatch;
    if (!matchResult?.match && createIfMissing && !createdMatchRef.current) {
      createdMatchRef.current = true;
      matchResult = await competitionApi.updateMatch({
        matchNo: "第 01 场",
        group: "学生组",
        venue: "A 赛场",
        blue: { name: "蓝队" },
        red: { name: "红队" },
      });
    }
    setMatchPayload({
      match: normalizeMatch(matchResult?.match),
      elapsedMs: Number(matchResult?.elapsedMs || 0),
      running: Boolean(matchResult?.running),
      fetchedAt: Date.now(),
    });
    setRecordList(Array.isArray(nextRecords?.records) ? nextRecords.records : []);
    setDevices(Array.isArray(nextDevices?.devices) ? nextDevices.devices : []);
    setBackendStatus("online");
    setApiError("");
  }

  useEffect(() => {
    if (!auth.authenticated) return undefined;
    let active = true;
    const refresh = () => refreshCompetition({ createIfMissing: true }).catch((error) => {
      if (!active) return;
      if (error.status === 401) {
        setAuth({ loading: false, authenticated: false, user: null });
        return;
      }
      setBackendStatus("offline");
      setApiError(error.message || "赛事数据同步失败");
    });
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [auth.authenticated]);

  useEffect(() => {
    function syncPageFromHash() {
      setPage(pageFromHash());
    }
    window.addEventListener("hashchange", syncPageFromHash);
    return () => window.removeEventListener("hashchange", syncPageFromHash);
  }, []);

  function changePage(nextPage) {
    if (!validPageIds.has(nextPage)) return;
    setPage(nextPage);
    if (window.location.hash !== `#${nextPage}`) {
      window.history.replaceState(null, "", `#${nextPage}`);
    }
  }

  async function login(email, password) {
    if (!email || !password) {
      setAuthError("请输入账号和密码");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    try {
      const result = await competitionApi.login(email, password);
      setAuth({ loading: false, authenticated: true, user: result.user || null });
    } catch (error) {
      setAuthError(error.message || "登录失败");
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    await competitionApi.logout().catch(() => {});
    setAuth({ loading: false, authenticated: false, user: null });
    setMatchPayload({ match: null, elapsedMs: 0, running: false, fetchedAt: Date.now() });
    setRecordList([]);
    setDevices([]);
  }

  async function performAction(action, body) {
    if (actionBusy) return;
    setActionBusy(true);
    setApiError("");
    try {
      const result = await competitionApi.action(action, body);
      setMatchPayload({
        match: normalizeMatch(result?.match),
        elapsedMs: Number(result?.elapsedMs || 0),
        running: Boolean(result?.running),
        fetchedAt: Date.now(),
      });
      const [nextRecords, nextDevices] = await Promise.all([competitionApi.getRecords(), competitionApi.getDevices()]);
      setRecordList(Array.isArray(nextRecords?.records) ? nextRecords.records : []);
      setDevices(Array.isArray(nextDevices?.devices) ? nextDevices.devices : []);
      setBackendStatus("online");
    } catch (error) {
      setApiError(error.message || "赛事操作失败");
      if (error.status === 401) setAuth({ loading: false, authenticated: false, user: null });
    } finally {
      setActionBusy(false);
    }
  }

  const displayedElapsedMs = matchPayload.running
    ? matchPayload.elapsedMs + Math.max(0, clockNow - matchPayload.fetchedAt)
    : matchPayload.elapsedMs;

  if (auth.loading) {
    return <main className="competitionLoading">正在连接赛事服务…</main>;
  }
  if (!auth.authenticated) {
    return <LoginGate onLogin={login} busy={authBusy} error={authError} />;
  }

  const currentMatch = matchPayload.match;

  return (
    <main
      className={`competitionApp page-${page}`}
      style={{ "--page-ratio": pageConfig.ratio, "--ratio-value": pageConfig.ratioValue }}
    >
      <div className="designShell">
        <Header page={page} onPageChange={changePage} user={auth.user} backendStatus={backendStatus} onLogout={logout} />
        {apiError && <div className="competitionApiError" role="status">{apiError}</div>}
        {page === "lobby" && <LobbyPage onPageChange={changePage} match={currentMatch} devices={devices} records={recordList} />}
        {page === "control" && <ControlPage match={currentMatch} elapsedMs={displayedElapsedMs} devices={devices} onAction={performAction} busy={actionBusy} />}
        {page === "missions" && <MissionsPage />}
        {page === "records" && <RecordsPage records={recordList} />}
        <footer className="competitionFooter">
          <span>比赛数据：{backendStatus === "online" ? "实时同步" : "等待重连"}　设备归属：后端管理</span>
          <span>FISH CONTROL · STUDENT COMPETITION PLATFORM</span>
        </footer>
      </div>
    </main>
  );
}
