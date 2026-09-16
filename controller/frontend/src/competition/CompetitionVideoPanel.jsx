import { useEffect, useState } from "react";
import VideoStream from "../VideoStream.jsx";

function readError(payload, fallback) {
  return payload?.error?.message || payload?.message || fallback;
}

async function request(path) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) throw new Error(readError(payload, `视频服务请求失败（${response.status}）`));
  return payload;
}

function sessionData(payload) {
  return payload?.data || payload || { state: "stopped" };
}

export default function CompetitionVideoPanel() {
  const [session, setSession] = useState({ state: "stopped" });
  const [feedback, setFeedback] = useState("");
  const [streamReady, setStreamReady] = useState(false);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const nextSession = sessionData(await request("/api/vision/sessions/current"));
        if (!active) return;
        setSession(nextSession);
        setFeedback("");
      } catch (error) {
        if (active) setFeedback(error.message || "无法读取裁判端视觉状态");
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const running = ["previewing", "processing", "tracking"].includes(session.state);
  const videoWidth = session.metrics?.frame?.width || 16;
  const videoHeight = session.metrics?.frame?.height || 9;

  return (
    <section className="competitionVideoPanel">
      <header className="competitionVideoHeader">
        <div><h2>实时场地视频</h2><p>裁判端统一配置 · 选手只观看赛事共享画面</p></div>
        <span className={`competitionVideoStatus ${running && streamReady ? "online" : "offline"}`}>
          <i />{running && streamReady ? "赛事共享视频在线" : running ? "视频连接中" : "等待裁判开启"}
        </span>
      </header>
      <div className="competitionVideoStage" style={{ "--competition-video-aspect": `${videoWidth} / ${videoHeight}` }}>
        {running && session.sessionId ? (
          <>
            <VideoStream
              sessionId={session.sessionId}
              quality="hd"
              className="competitionLiveVideo"
              alt="裁判端配置的赛事共享摄像头视频"
              onReady={() => setStreamReady(true)}
              onError={() => { setStreamReady(false); setFeedback("视频连接中断，等待裁判端恢复"); }}
            />
            {!streamReady && <div className="competitionVideoPlaceholder"><strong>正在连接裁判端共享视频…</strong><span>摄像头选择和视觉识别由裁判端统一管理</span></div>}
          </>
        ) : (
          <div className="competitionVideoPlaceholder"><strong>等待裁判端开启视频</strong><span>{feedback || "选手端不能选择或启动摄像头"}</span></div>
        )}
        {feedback && <p className="competitionVideoFeedback" role="status">{feedback}</p>}
      </div>
    </section>
  );
}
