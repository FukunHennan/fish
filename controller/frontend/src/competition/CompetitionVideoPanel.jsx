import { useEffect, useRef, useState } from "react";
import VideoStream from "../VideoStream.jsx";

function readError(payload, fallback) {
  return payload?.error?.message || payload?.message || fallback;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) throw new Error(readError(payload, `视频服务请求失败（${response.status}）`));
  return payload;
}

function sessionData(payload) {
  return payload?.data || payload || { state: "stopped" };
}

function cameraLabel(camera, index) {
  const name = camera?.model || camera?.name || `服务器摄像头 ${camera?.index ?? index + 1}`;
  const size = camera?.width && camera?.height ? `${camera.width}×${camera.height}` : "";
  const fps = camera?.fps ? `${camera.fps} FPS` : "";
  return [name, size, fps].filter(Boolean).join(" · ");
}

function browserCameraLabel(camera, index) {
  const name = camera?.label || `本机摄像头 ${index + 1}`;
  return /integrated|built[- ]?in|内置|facetime/i.test(name) ? `${name} · 电脑自带` : name;
}

export default function CompetitionVideoPanel() {
  const [source, setSource] = useState("server");
  const [cameras, setCameras] = useState([]);
  const [cameraIndex, setCameraIndex] = useState("");
  const [session, setSession] = useState({ state: "stopped" });
  const [browserCameras, setBrowserCameras] = useState([]);
  const [browserDeviceId, setBrowserDeviceId] = useState("");
  const [browserStream, setBrowserStream] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [retry, setRetry] = useState(0);
  const [streamReady, setStreamReady] = useState(false);
  const browserVideoRef = useRef(null);

  const running = ["previewing", "processing", "tracking"].includes(session.state);

  useEffect(() => {
    if (browserVideoRef.current) browserVideoRef.current.srcObject = browserStream;
    if (browserStream) browserVideoRef.current?.play().catch(() => {});
  }, [browserStream]);

  useEffect(() => () => browserStream?.getTracks().forEach((track) => track.stop()), [browserStream]);

  async function refreshBrowserCameras(requestPermission = false) {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error("当前浏览器不支持本机摄像头选择");
    if (requestPermission && !browserStream) {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      permissionStream.getTracks().forEach((track) => track.stop());
    }
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput");
    setBrowserCameras(list);
    setBrowserDeviceId((current) => current && list.some((item) => item.deviceId === current)
      ? current : list[0]?.deviceId || "");
    return list;
  }

  useEffect(() => {
    refreshBrowserCameras(false).catch(() => {});
    const refresh = () => refreshBrowserCameras(false).catch(() => {});
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, []);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [cameraPayload, sessionPayload] = await Promise.all([
          request("/api/vision/cameras"),
          request("/api/vision/sessions/current"),
        ]);
        if (!active) return;
        const cameraList = Array.isArray(cameraPayload) ? cameraPayload : [];
        const nextSession = sessionData(sessionPayload);
        setCameras(cameraList);
        setSession(nextSession);
        setCameraIndex((current) => current !== ""
          && cameraList.some((camera) => String(camera.index) === String(current))
          ? current
          : nextSession.cameraIndex != null
            ? String(nextSession.cameraIndex)
            : cameraList[0]?.index != null ? String(cameraList[0].index) : "");
      } catch (error) {
        if (active) setFeedback(error.message);
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function startServerVideo() {
    if (cameraIndex === "") {
      setFeedback("请先选择服务器摄像头");
      return;
    }
    setBusy(true);
    setFeedback("正在启动真实摄像头视频…");
    try {
      const result = await request("/api/vision/sessions", {
        method: "POST",
        body: JSON.stringify({ cameraId: `camera-${cameraIndex}`, cameraIndex: Number(cameraIndex), trackingMode: "single_fish" }),
      });
      setSession(sessionData(result));
      setStreamReady(false);
      setFeedback("真实视频已启动，正在建立浏览器视频连接…");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function stopServerVideo() {
    if (!session.sessionId) return;
    setBusy(true);
    try {
      const result = await request(`/api/vision/sessions/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" });
      setSession(sessionData(result));
      setStreamReady(false);
      setFeedback("服务器视频已停止");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function switchServerCamera(nextIndex) {
    setCameraIndex(nextIndex);
    if (!running || !session.sessionId || nextIndex === "") return;
    setBusy(true);
    setStreamReady(false);
    try {
      const result = await request(`/api/vision/sessions/${encodeURIComponent(session.sessionId)}/camera`, {
        method: "POST",
        body: JSON.stringify({ cameraId: `camera-${nextIndex}`, cameraIndex: Number(nextIndex) }),
      });
      setSession(sessionData(result));
      setRetry((value) => value + 1);
      setFeedback("服务器摄像头已切换，视频保持开启");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function startBrowserVideo(deviceId = browserDeviceId) {
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false,
      });
      browserStream?.getTracks().forEach((track) => track.stop());
      setBrowserStream(stream);
      setFeedback("电脑摄像头预览已接入；它独立于服务器识别和机器鱼控制");
      await refreshBrowserCameras(false);
    } catch (error) {
      setFeedback(error.message || "电脑摄像头无法开启");
    } finally {
      setBusy(false);
    }
  }

  function stopBrowserVideo() {
    browserStream?.getTracks().forEach((track) => track.stop());
    setBrowserStream(null);
    setFeedback("电脑摄像头预览已关闭");
  }

  async function changeSource(event) {
    const next = event.target.value;
    setSource(next);
    setStreamReady(false);
    if (next === "browser") {
      try {
        const list = await refreshBrowserCameras(true);
        if (list.length) await startBrowserVideo(browserDeviceId || list[0].deviceId);
      } catch (error) {
        setSource("server");
        setFeedback(error.message);
      }
    } else {
      stopBrowserVideo();
      setFeedback(running ? "已切回服务器真实视频" : "已切回服务器摄像头");
    }
  }

  const selectedCamera = cameras.find((camera) => String(camera.index) === String(cameraIndex));
  const videoWidth = session.metrics?.frame?.width || selectedCamera?.width || 16;
  const videoHeight = session.metrics?.frame?.height || selectedCamera?.height || 9;

  return (
    <section className="competitionVideoPanel">
      <header className="competitionVideoHeader">
        <div><h2>实时场地视频</h2><p>真实摄像头画面 · 视频与手动操控独立</p></div>
        <span className={`competitionVideoStatus ${source === "browser" ? (browserStream ? "online" : "offline") : (running && streamReady ? "online" : "offline")}`}>
          <i />{source === "browser" ? (browserStream ? "电脑摄像头" : "未开启") : (running && streamReady ? "服务器视频在线" : running ? "视频连接中" : "服务器未启动")}
        </span>
      </header>
      <div className="competitionVideoToolbar">
        <label>画面来源<select value={source} disabled={busy} onChange={changeSource}><option value="server">服务器摄像头 · 赛事共享</option><option value="browser">电脑摄像头 · 本机预览</option></select></label>
        {source === "server" ? (
          <label>服务器摄像头<select value={cameraIndex} disabled={busy} onChange={(event) => switchServerCamera(event.target.value)}><option value="">暂无可用摄像头</option>{cameras.map((camera, index) => <option key={camera.index} value={camera.index}>{cameraLabel(camera, index)}</option>)}</select></label>
        ) : (
          <label>电脑摄像头<select value={browserDeviceId} disabled={busy || !browserCameras.length} onChange={(event) => { setBrowserDeviceId(event.target.value); startBrowserVideo(event.target.value); }}><option value="">请选择电脑摄像头</option>{browserCameras.map((camera, index) => <option key={camera.deviceId || index} value={camera.deviceId}>{browserCameraLabel(camera, index)}</option>)}</select></label>
        )}
        {source === "server" && <button type="button" className="competitionVideoAction" disabled={busy || (running ? !session.sessionId : cameraIndex === "")} onClick={running ? stopServerVideo : startServerVideo}>{running ? "停止服务器视频" : "启动真实视频"}</button>}
        {source === "browser" && <button type="button" className="competitionVideoAction" disabled={busy || (!browserStream && !browserDeviceId)} onClick={browserStream ? stopBrowserVideo : () => startBrowserVideo()}>{browserStream ? "关闭本机预览" : "打开本机预览"}</button>}
      </div>
      <div className="competitionVideoStage" style={{ "--competition-video-aspect": `${videoWidth} / ${videoHeight}` }}>
        {source === "browser" ? (
          browserStream ? <video ref={browserVideoRef} className="competitionLiveVideo" autoPlay muted playsInline aria-label="电脑摄像头实时预览" /> : <div className="competitionVideoPlaceholder"><strong>电脑摄像头预览未开启</strong><span>选择摄像头并打开本机预览</span></div>
        ) : running && session.sessionId ? (
          <>
            <VideoStream
              sessionId={session.sessionId}
              quality="hd"
              retry={retry}
              className="competitionLiveVideo"
              alt="服务器真实摄像头视频"
              onReady={() => setStreamReady(true)}
              onError={() => { setStreamReady(false); setFeedback("视频连接中断，请稍候重试"); }}
            />
            {!streamReady && <div className="competitionVideoPlaceholder"><strong>正在连接真实视频…</strong><span>摄像头会话已启动，浏览器正在建立视频流</span></div>}
          </>
        ) : (
          <div className="competitionVideoPlaceholder"><strong>服务器视频未启动</strong><span>{feedback || "选择服务器摄像头后点击启动真实视频"}</span></div>
        )}
        {feedback && <p className="competitionVideoFeedback" role="status">{feedback}</p>}
      </div>
    </section>
  );
}
