import { useEffect, useRef, useState } from "react";
import { chooseCameraIndex, toVideoPoint } from "./coordinates.js";
import { visionStreamSource } from "./visionStream.js";
import { transitionVisionTool } from "./visionTools.js";
import { canEditVision, visionRequest, visionStreamUrl } from "./visionSession.js";

const TOOLS = [
  ["calibration", "场地标定"],
  ["path", "绘制轨迹"],
];

const WORKFLOW_STAGES = [
  ["targetDetected", "单鱼目标"],
  ["headingCalibrated", "方向标定"],
  ["poolCalibrated", "场地标定"],
  ["pathReady", "轨迹路径"],
  ["trackingActive", "循迹运行"],
];

const STAGE_LABELS = {
  INITIALIZING: "系统初始化",
  PREPARING: "循迹准备中",
  HEADING_CALIBRATING: "正在标定方向",
  READY: "可以启动循迹",
  TRACKING: "循迹运行中",
};

export default function VisionPanel() {
  const [cameras, setCameras] = useState([]);
  const [cameraIndex, setCameraIndex] = useState("");
  const [status, setStatus] = useState({ state: "stopped", error: "" });
  const [feedback, setFeedback] = useState("");
  const [tool, setTool] = useState("");
  const [drag, setDrag] = useState(null);
  const [streamRetry, setStreamRetry] = useState(0);
  const [streamFeedback, setStreamFeedback] = useState("");
  const imageRef = useRef(null);
  const retryTimerRef = useRef(null);

  const running = ["previewing", "processing", "tracking"].includes(status.state);
  const processing = ["processing", "tracking"].includes(status.state);
  const editable = canEditVision(status);
  const selectedCamera = cameras.find((camera) => camera.index === Number(cameraIndex));
  const videoWidth = status.metrics?.frame?.width || selectedCamera?.width || 640;
  const videoHeight = status.metrics?.frame?.height || selectedCamera?.height || 480;
  const yolo = status.metrics?.yolo;
  const detections = yolo?.detections || [];
  const workflow = status.metrics?.workflow || {};
  const workflowLabel = STAGE_LABELS[workflow.stage] || "等待视觉状态";
  const yoloLabel = yolo?.ready ? "YOLO 就绪" : yolo?.loading ? "YOLO 加载中" : yolo?.error ? "YOLO 异常" : "YOLO 等待启动";

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [cameraResponse, statusResponse] = await Promise.all([
          fetch("/api/vision/cameras", { cache: "no-store" }),
          fetch("/api/vision/sessions/current", { cache: "no-store" }),
        ]);
        if (!cameraResponse.ok || !statusResponse.ok) throw new Error("视觉后台未就绪");
        const cameraList = await cameraResponse.json();
        const statusEnvelope = await statusResponse.json();
        const nextStatus = statusEnvelope.data || statusEnvelope;
        if (!active) return;
        setCameras(cameraList);
        setStatus(nextStatus);
        setCameraIndex((current) => chooseCameraIndex(current, cameraList, nextStatus));
      } catch (error) {
        if (active) setFeedback(error.message);
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  useEffect(() => {
    if (!running) {
      window.clearTimeout(retryTimerRef.current);
      setStreamRetry(0);
      setStreamFeedback("");
    }
  }, [running]);

  useEffect(() => {
    const action = status.lastAction;
    if (action?.type !== "camera.exposure" || action.status === undefined) return;
    if (action.status === "completed") setFeedback(`实际曝光：${action.actualValue}`);
    else if (action.errorCode === "exposure_not_applied") setFeedback("摄像头驱动未应用曝光值");
    else setFeedback("当前摄像头不支持手动曝光");
  }, [status.lastAction]);

  function reconnectStream() {
    setStreamFeedback("视频流中断，正在自动重连…");
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      setStreamRetry((current) => current + 1);
    }, 1000);
  }

  function streamConnected() {
    window.clearTimeout(retryTimerRef.current);
    setStreamFeedback("");
  }

  async function start() {
    try {
      if (cameraIndex === "") throw new Error("请选择摄像头");
      const result = await visionRequest("/sessions", { method: "POST", body: JSON.stringify({ cameraId: `camera-${cameraIndex}`, cameraIndex: Number(cameraIndex) }) });
      setStatus(result.data);
      setFeedback("摄像头预览已启动");
    } catch (error) { setFeedback(error.message); }
  }

  async function stop() {
    try {
      if (processing) await sendAction({ type: "system.stop" }, false);
      const result = await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}`, { method: "DELETE" });
      setStatus(result.data);
      setTool("");
      setFeedback("视觉服务已停止");
    } catch (error) { setFeedback(error.message); }
  }

  async function sendAction(action, report = true) {
    const actionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const result = await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}/actions`, { method: "POST", body: JSON.stringify({ ...action, actionId }) });
    if (report) setFeedback(result.data.accepted ? "操作已确认" : "操作未接受");
    return result;
  }

  async function toggleProcessing() {
    try {
      const result = await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}/processing`, { method: processing ? "DELETE" : "POST" });
      setStatus(result.data);
      setTool("");
      setFeedback(processing ? "视觉处理已停止，保留预览" : "视觉处理已启动");
    } catch (error) { setFeedback(error.message); }
  }

  async function selectTool(nextTool) {
    const { activeTool, actionType } = transitionVisionTool(tool, nextTool);
    setTool(activeTool);
    if (actionType) await sendAction({ type: actionType });
    setFeedback(activeTool
      ? `${TOOLS.find(([name]) => name === activeTool)?.[1]}模式`
      : "画布工具已关闭");
  }

  function pointFrom(event) {
    const image = imageRef.current;
    return toVideoPoint(event, image.getBoundingClientRect(), videoWidth, videoHeight, image.naturalWidth, image.naturalHeight);
  }

  function pointerDown(event) {
    if (!editable || !tool) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFrom(event);
    if (tool === "path") setDrag({ start: point, points: [point] });
    else if (tool === "marker") setDrag({ start: point, points: [point] });
  }

  function pointerMove(event) {
    if (!drag || tool !== "path") return;
    const point = pointFrom(event);
    const last = drag.points[drag.points.length - 1];
    if ((point.x - last.x) ** 2 + (point.y - last.y) ** 2 >= 16) {
      setDrag({ ...drag, points: [...drag.points, point] });
    }
  }

  async function pointerUp(event) {
    if (!editable || !tool) return;
    const point = pointFrom(event);
    try {
      if (tool === "calibration") await sendAction({ type: "calibration.point", ...point });
      if (tool === "heading") await sendAction({ type: "heading.point", ...point });
      if (tool === "marker" && drag) await sendAction({ type: "marker.roi", x: drag.start.x, y: drag.start.y, x2: point.x, y2: point.y });
      if (tool === "path" && drag) await sendAction({ type: "path.draw", points: [...drag.points, point].map(({ x, y }) => [x, y]) });
    } catch (error) { setFeedback(error.message); }
    setDrag(null);
  }

  return (
    <section className="vision-card" aria-label="视觉控制">
      <header className="vision-header">
        <div><span className="eyebrow">FISH VISION</span><h2>视觉工作区</h2></div>
        <div className="vision-header-status"><span className={`status ${running ? "online" : "offline"}`}><i />{running ? "运行中" : "已停止"}</span><span className={`status ${yolo?.ready ? "online" : "offline"}`}><i />{yoloLabel}</span></div>
      </header>
      <div className="vision-layout">
        <div className="video-stage" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
          {running ? <img ref={imageRef} src={visionStreamUrl(status.sessionId, streamRetry)} onError={reconnectStream} onLoad={streamConnected} alt="机器鱼视觉处理画面" draggable="false" /> : <div className="video-placeholder"><strong>视觉画面未启动</strong><span>选择摄像头后开始预览</span></div>}
          {running && <div className="video-badge">{videoWidth} × {videoHeight}</div>}
        </div>
        <aside className="vision-controls">
          <label className="camera-select">摄像头<select value={cameraIndex} disabled={running} onChange={(event) => setCameraIndex(event.target.value)}><option value="">请选择摄像头</option>{cameras.map((camera) => <option key={camera.index} value={camera.index}>{camera.name} · {camera.width}×{camera.height} @ {camera.fps}FPS</option>)}</select></label>
          <div className="vision-primary"><button disabled={running || cameraIndex === ""} onClick={start}>开始预览</button><button disabled={!running} onClick={toggleProcessing}>{processing ? "停止视觉处理" : "启动视觉处理"}</button><button className="stop" disabled={!running} onClick={stop}>关闭视频</button></div>
          <section className="vision-targets"><strong>检测目标 · {detections.length}</strong>{detections.length ? detections.map((target) => <div key={target.trackId}><i style={{ background: target.colorHex }} /><span>目标 #{target.trackId}</span><b>{target.color}</b><small>{Math.round(target.confidence * 100)}%</small></div>) : <p>{processing ? "暂未检测到机器鱼" : "启动视觉处理后显示目标"}</p>}</section>
          <section className={`vision-workflow ${workflow.trackingActive ? "active" : ""}`}>
            <header><strong>循迹流程</strong><span>{workflowLabel}</span></header>
            <div>{WORKFLOW_STAGES.map(([key, label], index) => {
              const complete = Boolean(workflow[key]);
              const current = !complete && WORKFLOW_STAGES.slice(0, index).every(([previous]) => workflow[previous]);
              return <p key={key} className={complete ? "complete" : current ? "current" : "pending"}><i>{complete ? "✓" : index + 1}</i><span>{label}</span><b>{complete ? "完成" : current ? "待处理" : "等待"}</b></p>;
            })}</div>
            {workflow.blockers?.length > 0 && <small>{workflow.blockers[0]}</small>}
          </section>
          <div className="tool-grid">{TOOLS.map(([name, label]) => <button key={name} className={tool === name ? "active" : ""} disabled={!editable} onClick={() => selectTool(name)}>{label}</button>)}</div>
          <div className="tool-grid compact">
            <button disabled={!running || !workflow.canCalibrateHeading} onClick={() => sendAction({ type: "heading.calibrate" })}>{workflow.headingCalibrating ? "方向标定中" : "方向标定"}</button>
            <button disabled={!running} onClick={() => sendAction({ type: "path.clear" })}>清除轨迹</button>
            <button disabled={!running} onClick={() => sendAction({ type: "recording.toggle" })}>录像</button>
            <button disabled={!running} onClick={() => sendAction({ type: "snapshot.capture" })}>截图</button>
          </div>
          <div className="tracking-actions"><button disabled={!running || !workflow.canStart} onClick={() => sendAction({ type: "tracking.start" })}>{workflow.headingCalibrating ? "方向标定中" : workflow.trackingActive ? "循迹运行中" : "启动循迹"}</button><button className="stop" disabled={!running} onClick={() => sendAction({ type: "tracking.stop" })}>停止循迹</button></div>
          <p className="feedback" aria-live="polite">{streamFeedback || feedback || yolo?.error || yolo?.lastInferenceError || (running ? `摄像头 ${status.cameraIndex} 正在处理 · ${yoloLabel}` : "视觉服务未启动")}</p>
        </aside>
      </div>
    </section>
  );
}
