import { useMemo, useRef, useState } from "react";

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

const records = [
  ["生态资源应急修复对抗", "2025-05-18 14:30", "128 分", "2v2 对抗"],
  ["多鱼跟随（8字形）", "2025-05-18 10:12", "95 分", "技术挑战"],
  ["智能走迷宫", "2025-05-17 16:20", "78 分", "自主任务"],
  ["生态资源应急修复对抗", "2025-05-16 15:08", "112 分", "2v2 对抗"],
  ["多鱼跟随（8字形）", "2025-05-15 11:26", "88 分", "技术挑战"],
  ["智能走迷宫", "2025-05-14 09:42", "67 分", "自主任务"],
];

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

function Header({ page, onPageChange }) {
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
      <p className="headerSlogan">{page === "control" ? "科技让水中运动更精彩" : "科技 · 协作 · 挑战 · 成长"}</p>
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
      <div className="poolGrid" />
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

function LobbyPage({ onPageChange }) {
  return (
    <section className="screen lobbyScreen">
      <aside className="spacePanel glassCard hoverCard">
        <header><h2>我的空间</h2><button type="button">›</button></header>
        <div className="teamBadge"><FishLogo /></div>
        <h3>海洋先锋队</h3>
        <p>探索 · 协作 · 创新<br />用科技让海洋更美好</p>
        <div className="deviceStatus"><i />已连接设备 2 台 · 视觉系统正常</div>
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
            <StatusTile label="赛事任务" value="1 个待开始" tone="orange" />
            <StatusTile label="训练记录" value="本周 3 次" />
            <StatusTile label="设备连接" value="2 台在线" tone="green" />
            <StatusTile label="系统状态" value="正常" tone="green" />
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

function MatchHud() {
  return (
    <section className="matchHud">
      <div className="hudTitle">
        <h2>生态资源应急修复对抗 · 2v2</h2>
        <p>控制 · 策略 · 协作 · 共建水下生态</p>
      </div>
      <div className="hudScore"><span>本局积分</span><b className="blue">72</b><em>:</em><b className="red">60</b></div>
      <StatusTile label="剩余时间" value="01:28" />
      <StatusTile label="资源采集" value="3/6" />
      <StatusTile label="生态点修复" value="1/2" tone="green" />
      <StatusTile label="协同交付" value="1/2" tone="orange" />
      <button type="button" className="visionBadge">视觉定位在线</button>
      <button type="button" className="stopButton">急停</button>
    </section>
  );
}

function ControlPage() {
  return (
    <section className="screen controlScreen">
      <MatchHud />
      <aside className="controlRail glassCard hoverCard">
        <header><h2>我的控制</h2><span>专注操控 · 为团队而战</span></header>
        <article className="controlFish">
          <span className="fishChip" />
          <div><h3>B1</h3><p>资源采集手</p></div>
          <b>我在控制</b>
        </article>
        <div className="telemetryGrid">
          <StatusTile label="电量" value="78%" tone="green" />
          <StatusTile label="网络" value="良好" />
          <StatusTile label="视觉" value="正常" />
          <StatusTile label="X" value="-1.25" />
          <StatusTile label="Y" value="0.36" />
          <StatusTile label="航向角" value="128°" />
        </div>
        <div className="wasdPad">
          <button type="button" className="forward">W<span>前进</span></button>
          <button type="button">A<span>左转</span></button>
          <button type="button">D<span>右转</span></button>
          <button type="button" className="space">SPACE<span>紧急停止</span></button>
        </div>
        <section className="railStatus">
          <h3>队友状态</h3>
          <p><span>B2</span><b>修复协作</b><em>仅查看，不可控制</em></p>
        </section>
      </aside>

      <main className="fieldPanel glassCard hoverCard">
        <header><h2>实时场地画面（顶部视角）</h2><span>LIVE　高清 / 30 FPS</span></header>
        <ControlPool />
        <footer><span>水池尺寸：6.0m × 4.0m</span><span>2026-09-11 14:32:18</span></footer>
      </main>

      <aside className="tacticsPanel">
        <section className="glassCard hoverCard">
          <header><h2>资源任务态势</h2><span>任务地图</span></header>
          <ControlPool compact />
          <div className="sideMetricRow">
            <StatusTile label="最近资源" value="0.72 m" tone="orange" />
            <StatusTile label="距生态点 A" value="1.38 m" tone="green" />
          </div>
          <article className="adviceCard hoverCard"><span className="cube" /><p><b>建议：采集资源 #3</b><small>位于左侧中部，距离较近，优先前往采集</small></p><i>›</i></article>
        </section>
        <section className="glassCard hoverCard">
          <h2>快捷团队信号</h2>
          <div className="signalButtons">
            <button type="button">采集资源</button>
            <button type="button">修复生态点</button>
            <button type="button">协同交付</button>
          </div>
        </section>
        <section className="glassCard hoverCard">
          <h2>赛事事件记录</h2>
          <p className="eventLine"><span>14:31</span>资源状态更新</p>
          <p className="eventLine"><span>14:32</span>协同交付确认</p>
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

function RecordsPage() {
  return (
    <section className="screen recordsScreen">
      <aside className="recordList glassCard hoverCard">
        <header><h2>任务记录</h2><button type="button">全部类型</button></header>
        {records.map(([title, date, score, type], index) => (
          <button type="button" className={`recordItem ${index === 0 ? "active" : ""}`} key={`${title}-${date}`}>
            <span className="recordThumb" />
            <strong>{title}</strong>
            <small>{date}</small>
            <b>{score}</b>
            <em>{type}</em>
          </button>
        ))}
      </aside>

      <main className="replayPanel">
        <section className="recordHeader glassCard hoverCard">
          <div><h2>生态资源应急修复对抗 · 任务回放</h2><p>学生组 · 2v2 对抗任务</p></div>
          <div className="winnerScore"><span>本局结果</span><strong>128 : 104</strong><b>本局获胜</b></div>
        </section>
        <section className="replayStage glassCard hoverCard">
          <header><h2>比赛视频回放</h2><select defaultValue="top"><option value="top">多视角：俯视视角</option></select></header>
          <ControlPool />
          <footer className="playbar"><button type="button">暂停</button><span>01:27 / 04:00</span><i /><select><option>1×</option></select></footer>
        </section>
        <section className="recordSummary">
          <article className="glassCard hoverCard"><h3>任务完成概览</h3><p>资源回收 <b>5/6</b></p><p>生态点修复 <b>2/2</b></p><p>协同交付 <b>2 次</b></p><p>违规 <b>0 次</b></p></article>
          <article className="glassCard hoverCard"><h3>我的操控统计（B1）</h3><p>前进 <b>46%</b></p><p>左转 <b>18%</b></p><p>右转 <b>22%</b></p><p>停止 <b>14%</b></p></article>
          <article className="glassCard hoverCard"><h3>队友协同表现（B2）</h3><p>资源传递 <b>6 次</b></p><p>修复支援 <b>4 次</b></p><p>协同距离 <b>1.2 m</b></p><p>有效协作时间 <b>72%</b></p></article>
        </section>
      </main>

      <aside className="scorePanel glassCard hoverCard">
        <h2>本局积分</h2>
        <div className="scoreTiles">
          <StatusTile label="资源采集" value="42 / 36" />
          <StatusTile label="生态点修复" value="40 / 30" tone="green" />
          <StatusTile label="协同交付" value="30 / 30" tone="orange" />
          <StatusTile label="安全规范" value="16 / 8" />
        </div>
        <section className="keyEvents">
          <h3>关键事件</h3>
          <p><span>00:42</span> 蓝队 采集资源 #3 <b>+10</b></p>
          <p><span>01:18</span> 红队 修复生态点 <b>+20</b></p>
          <p><span>02:43</span> 蓝队 协同交付 <b>+15</b></p>
          <p><span>04:00</span> 任务结束 <b>-</b></p>
        </section>
        <button type="button" className="retryButton">再次挑战</button>
      </aside>
    </section>
  );
}

export default function CompetitionApp() {
  const [page, setPage] = useState("lobby");
  const pageConfig = pages.find((item) => item.id === page) || pages[0];

  return (
    <main
      className={`competitionApp page-${page}`}
      style={{ "--page-ratio": pageConfig.ratio, "--ratio-value": pageConfig.ratioValue }}
    >
      <div className="designShell">
        <Header page={page} onPageChange={setPage} />
        {page === "lobby" && <LobbyPage onPageChange={setPage} />}
        {page === "control" && <ControlPage />}
        {page === "missions" && <MissionsPage />}
        {page === "records" && <RecordsPage />}
        <footer className="competitionFooter">
          <span>边界保护：正常　队内通信：正常　延迟：12ms　丢包：0%</span>
          <span>FISH CONTROL · STUDENT COMPETITION PLATFORM</span>
        </footer>
      </div>
    </main>
  );
}
