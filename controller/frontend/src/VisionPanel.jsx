import { useEffect, useRef, useState } from "react";
import { chooseCameraIndex, toVideoPoint } from "./coordinates.js";
import { transitionVisionTool } from "./visionTools.js";
import { canEditVision, visionEventUrl, visionRequest } from "./visionSession.js";
import { formatFrameLatency, formatServerClock, formatVideoClock } from "./videoTime.js";
import VideoStream from "./VideoStream.jsx";

const TOOLS = [
  ["path", "绘制轨迹"],
  ["calibration", "场地测量标定（可选）"],
];

const WORKFLOW_STAGES = [
  ["targetDetected", "单鱼目标"],
  ["headingCalibrated", "方向标定"],
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

const CONTROL_MODES = [
  ["detect", "只识别", "只识别，不自动控制"],
  ["assist", "辅助驾驶", "视觉辅助，手动仍优先"],
  ["auto", "自动巡航", "自动巡航，需要管理员确认"],
];

const DEFAULT_OVERLAYS = { detections: false, paths: false };

function sessionErrorMessage(status) {
  const error = status?.error;
  if (!error) return "";
  return typeof error === "string" ? error : error.message || error.code || "";
}

function cameraLabel(camera) {
  const model = camera.model || camera.name || `摄像头 ${camera.index}`;
  const size = camera.width && camera.height ? `${camera.width}×${camera.height}` : "";
  const fps = camera.fps ? `${camera.fps}FPS` : "";
  const capability = [size, fps].filter(Boolean).join(" @ ");
  return [`#${camera.index}`, model, capability].filter(Boolean).join(" · ");
}

export default function VisionPanel({
  devices = [],
  targetDeviceId = "",
  onTargetDeviceChange = () => {},
  onVisionStateChange = () => {},
  mode = "vision",
  showTargetDeviceSelector = true,
}) {
  const [cameras, setCameras] = useState([]);
  const [cameraIndex, setCameraIndex] = useState("");
  const [status, setStatus] = useState({ state: "stopped", error: "" });
  const [feedback, setFeedback] = useState("");
  const [tool, setTool] = useState("");
  const [drag, setDrag] = useState(null);
  const [streamRetry, setStreamRetry] = useState(0);
  const [streamFeedback, setStreamFeedback] = useState("");
  const [streamState, setStreamState] = useState("idle");
  const [switchingCamera, setSwitchingCamera] = useState(false);
  const [yoloModels, setYoloModels] = useState([]);
  const [selectedYoloModel, setSelectedYoloModel] = useState("");
  const [controlMode, setControlMode] = useState("detect");
  const [autoSpeed, setAutoSpeed] = useState(42);
  const [autoAmplitude, setAutoAmplitude] = useState(35);
  const [autoConfidence, setAutoConfidence] = useState(80);
  const [overlayPrefs, setOverlayPrefs] = useState(DEFAULT_OVERLAYS);
  const [clock, setClock] = useState(() => formatVideoClock());
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [serverTime, setServerTime] = useState(null);
  const [serverUtcOffsetMinutes, setServerUtcOffsetMinutes] = useState(0);
  const [serverTimeReceivedAt, setServerTimeReceivedAt] = useState(0);
  const [exposurePercent, setExposurePercent] = useState(50);
  const [exposureMaxInput, setExposureMaxInput] = useState("");
  const imageRef = useRef(null);
  const retryTimerRef = useRef(null);
  const exposurePendingRef = useRef(null);
  const camerasRef = useRef([]);
  const targetDeviceIdRef = useRef(targetDeviceId);

  const manual = mode === "manual";
  const running = ["previewing", "processing", "tracking"].includes(status.state);
  const processing = ["processing", "tracking"].includes(status.state);
  const editable = canEditVision(status);
  const selectedCamera = cameras.find((camera) => camera.index === Number(cameraIndex));
  const videoWidth = status.metrics?.frame?.width || selectedCamera?.width || 640;
  const videoHeight = status.metrics?.frame?.height || selectedCamera?.height || 480;
  const yolo = status.metrics?.yolo;
  const overlays = { ...DEFAULT_OVERLAYS, ...overlayPrefs, ...(status.metrics?.overlays || {}) };
  const detections = yolo?.detections || [];
  const workflow = status.metrics?.workflow || {};
  const workflowLabel = STAGE_LABELS[workflow.stage] || "等待视觉状态";
  const yoloLabel = yolo?.ready ? "YOLO 就绪" : yolo?.loading ? "YOLO 加载中" : yolo?.error ? "YOLO 异常" : "YOLO 等待启动";
  const coordinateLabel = workflow.controlCoordinateMode === "FIELD" ? "场地坐标" : "画面坐标";
  const targetRequiredForMotion = !targetDeviceId;
  const exposure = status.metrics?.exposure || {};
  const controlModeLabel = CONTROL_MODES.find(([name]) => name === controlMode)?.[2] || "只识别，不自动控制";
  const latencyLabel = formatFrameLatency(status.metrics);
  const serverClock = formatServerClock(
    serverTime,
    serverUtcOffsetMinutes,
    serverTimeReceivedAt,
    clockTick,
  );
  const exposureMin = Number(exposure.minimum);
  const exposureDriverMax = Number(exposure.maximum);
  const exposureStep = Number(exposure.step) > 0 ? Number(exposure.step) : 1;
  const exposureRangeReady = (
    exposure.supported !== false
    && Number.isFinite(exposureMin)
    && Number.isFinite(exposureDriverMax)
    && exposureDriverMax > exposureMin
  );
  const requestedExposureMax = Number(exposureMaxInput);
  const snapExposureValue = (value) => {
    if (!exposureRangeReady) return null;
    const bounded = Math.min(exposureDriverMax, Math.max(exposureMin, Number(value)));
    if (bounded >= exposureDriverMax) return exposureDriverMax;
    const stepped = exposureMin + Math.round((bounded - exposureMin) / exposureStep) * exposureStep;
    return Math.min(exposureDriverMax, Math.max(exposureMin, stepped));
  };
  const exposureMax = exposureRangeReady
    ? snapExposureValue(
      Number.isFinite(requestedExposureMax) ? requestedExposureMax : exposureDriverMax,
    )
    : null;
  const legalExposureValue = (percent, maximum = exposureMax) => {
    if (!exposureRangeReady || maximum === null) return null;
    const boundedPercent = Math.min(100, Math.max(0, Number(percent) || 0));
    const raw = exposureMin + (maximum - exposureMin) * boundedPercent / 100;
    const stepped = exposureMin + Math.round((raw - exposureMin) / exposureStep) * exposureStep;
    return Math.min(exposureDriverMax, Math.max(exposureMin, stepped));
  };
  const previewExposureValue = legalExposureValue(exposurePercent);
  let exposureHelp = exposureRangeReady
    ? `驱动范围 ${exposureMin}–${exposureDriverMax}，按 ${exposureStep} 步进取整`
    : "当前摄像头没有提供可用的曝光范围";
  if (exposure.supported === false) exposureHelp = "当前摄像头不支持手动曝光";
  if (exposure.errorCode === "exposure_not_applied") exposureHelp = "驱动未应用曝光值";

  const sharedOverlayPanel = (
    <section className="overlay-panel">
      <header><strong>画面叠加</strong><span>只影响显示，不影响识别/控制</span></header>
      <div className="overlay-toggle-row compact">
        <label><input type="checkbox" checked={overlays.detections} disabled={!running} onChange={(event) => setOverlay("detections", event.target.checked)} /> YOLO 识别</label>
        <label><input type="checkbox" checked={overlays.paths} disabled={!running} onChange={(event) => setOverlay("paths", event.target.checked)} /> 路径/轨迹</label>
      </div>
    </section>
  );

  const sharedExposurePanel = (
    <section className="exposure-control">
      <header><strong>摄像头曝光</strong><span>实际 {exposure.actualValue ?? "—"}</span></header>
      <label className="exposure-limit-row">
        <span>曝光上限</span>
        <input
          type="number"
          min={exposureRangeReady ? exposureMin : undefined}
          max={exposureRangeReady ? exposureDriverMax : undefined}
          step={exposureRangeReady ? exposureStep : 1}
          value={exposureMaxInput}
          disabled={!exposureRangeReady}
          onChange={(event) => setExposureMaxInput(event.target.value)}
          onBlur={normalizeExposureMax}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          aria-label="曝光上限"
        />
      </label>
      <label className="exposure-slider-row">
        <span>曝光百分比 <b>{Math.round(exposurePercent)}%</b></span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={exposurePercent}
          disabled={!running || !exposureRangeReady}
          onChange={(event) => setExposurePercent(Number(event.target.value))}
          onPointerUp={(event) => commitExposurePercent(event.currentTarget.value)}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              commitExposurePercent(event.currentTarget.value);
            }
          }}
          onBlur={(event) => commitExposurePercent(event.currentTarget.value)}
          aria-label="曝光百分比"
        />
        <output>{previewExposureValue ?? "—"}</output>
      </label>
      <small>{exposureHelp}</small>
    </section>
  );

  function captureServerTime(payload) {
    const value = Number(payload?.serverTime ?? payload?.data?.serverTime);
    if (!Number.isFinite(value)) return;
    setServerTime(value);
    const offset = Number(payload?.serverUtcOffsetMinutes ?? payload?.data?.serverUtcOffsetMinutes);
    if (Number.isFinite(offset)) setServerUtcOffsetMinutes(offset);
    setServerTimeReceivedAt(Date.now());
  }

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
        camerasRef.current = cameraList;
        captureServerTime(statusEnvelope);
        setCameras(cameraList);
        setStatus(nextStatus);
        if (nextStatus.yoloModel) setSelectedYoloModel(nextStatus.yoloModel);
        setCameraIndex((current) => chooseCameraIndex(current, cameraList, nextStatus));
      } catch (error) {
        if (active) setFeedback(error.message);
      }
    }
    refresh();
    if (typeof window.EventSource !== "function") {
      if (active) setFeedback("当前浏览器不支持视觉状态推送");
      return () => { active = false; };
    }
    const source = new window.EventSource(visionEventUrl());
    source.addEventListener("session", (event) => {
      if (!active) return;
      try {
        const envelope = JSON.parse(event.data);
        const nextStatus = envelope.data || envelope;
        captureServerTime(envelope);
        setStatus(nextStatus);
        if (nextStatus.yoloModel) setSelectedYoloModel(nextStatus.yoloModel);
        setCameraIndex((current) => chooseCameraIndex(current, camerasRef.current, nextStatus));
      } catch {
        setFeedback("视觉状态数据无效");
      }
    });
    return () => {
      active = false;
      source.close();
    };
  }, []);

  useEffect(() => {
    if (manual || targetDeviceIdRef.current === targetDeviceId) return undefined;
    const previousTargetDeviceId = targetDeviceIdRef.current;
    targetDeviceIdRef.current = targetDeviceId;
    if (!running || !status.sessionId) return undefined;
    let active = true;
    visionRequest(
      `/sessions/${encodeURIComponent(status.sessionId)}/target`,
      {
        method: "POST",
        body: JSON.stringify({ targetDeviceId }),
      },
    ).then((result) => {
      if (!active) return;
      setStatus(result.data);
      setFeedback(targetDeviceId ? "目标机器鱼已绑定。" : "已取消目标机器鱼，当前只预览和识别。");
    }).catch((error) => {
      if (!active) return;
      targetDeviceIdRef.current = previousTargetDeviceId;
      onTargetDeviceChange(previousTargetDeviceId);
      setFeedback(error.message);
    });
    return () => { active = false; };
  }, [manual, onTargetDeviceChange, running, status.sessionId, targetDeviceId]);

  useEffect(() => {
    if (manual) return;
    onVisionStateChange({
      state: status.state,
      sessionId: status.sessionId || null,
      targetDeviceId: status.targetDeviceId || targetDeviceId || "",
      metrics: status.metrics || {},
    });
  }, [manual, onVisionStateChange, status, targetDeviceId]);

  useEffect(() => {
    let active = true;
    fetch("/api/vision/yolo/models", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("YOLO 模型列表读取失败")))
      .then((data) => {
        if (!active) return;
        const models = Array.isArray(data.models) ? data.models : [];
        setYoloModels(models);
        setSelectedYoloModel((current) => current || data.default || models[0] || "");
      })
      .catch((error) => {
        if (active) setFeedback(error.message);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  useEffect(() => {
    const tick = () => {
      setClock(formatVideoClock());
      setClockTick(Date.now());
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!running) {
      window.clearTimeout(retryTimerRef.current);
      setStreamRetry(0);
      setStreamFeedback("");
      setStreamState("idle");
    } else {
      setStreamState("loading");
    }
  }, [running]);

  useEffect(() => {
    const action = status.lastAction;
    if (action?.type !== "camera.exposure" || action.status === undefined) return;
    exposurePendingRef.current = null;
    if (action.status === "completed") {
      setFeedback(`实际曝光：${action.actualValue}`);
      if (Number.isFinite(Number(action.actualValue))) {
        const actual = Number(action.actualValue);
        const percentage = exposureMax > exposureMin
          ? ((actual - exposureMin) / (exposureMax - exposureMin)) * 100
          : 0;
        setExposurePercent(Math.round(Math.min(100, Math.max(0, percentage))));
      }
    }
    else if (action.errorCode === "exposure_not_applied") setFeedback("摄像头驱动未应用曝光值");
    else setFeedback("当前摄像头不支持手动曝光");
  }, [exposureMax, exposureMin, status.lastAction]);

  useEffect(() => {
    if (!exposureRangeReady) return;
    if (exposurePendingRef.current !== null) return;
    setExposureMaxInput((current) => {
      const currentValue = Number(current);
      if (!current || !Number.isFinite(currentValue)) return String(exposureDriverMax);
      return String(snapExposureValue(currentValue));
    });
    const actual = Number(exposure.actualValue);
    if (Number.isFinite(actual) && exposureMax > exposureMin) {
      setExposurePercent(
        Math.round(Math.min(100, Math.max(0, ((actual - exposureMin) / (exposureMax - exposureMin)) * 100))),
      );
    }
  }, [
    exposure.actualValue,
    exposureDriverMax,
    exposureMin,
    exposureMax,
    exposureRangeReady,
  ]);

  function reconnectStream() {
    setStreamState("error");
    setStreamFeedback("视频流中断，正在自动重连…");
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => setStreamRetry((current) => current + 1), 1000);
  }

  function streamConnected() {
    setStreamState("ready");
    window.clearTimeout(retryTimerRef.current);
    setStreamFeedback("");
  }

  async function start() {
    try {
      if (cameraIndex === "") throw new Error("请选择摄像头");
      const payload = { cameraId: `camera-${cameraIndex}`, cameraIndex: Number(cameraIndex) };
      if (targetDeviceId) payload.targetDeviceId = targetDeviceId;
      if (selectedYoloModel) payload.yoloModel = selectedYoloModel;
      const result = await visionRequest("/sessions", { method: "POST", body: JSON.stringify(payload) });
      setStatus(result.data);
      setSelectedYoloModel(result.data.yoloModel || selectedYoloModel);
      captureServerTime(result);
      setFeedback(targetDeviceId ? "摄像头预览已启动，已绑定目标鱼" : "摄像头预览已启动；未选择目标鱼，仅预览/识别");
    } catch (error) { setFeedback(error.message); }
  }

  async function changeCamera(event) {
    const nextCameraIndex = event.target.value;
    if (!running) {
      setCameraIndex(nextCameraIndex);
      return;
    }
    if (Number(nextCameraIndex) === status.cameraIndex || switchingCamera) return;
    const previousCameraIndex = String(status.cameraIndex);
    setCameraIndex(nextCameraIndex);
    setSwitchingCamera(true);
    setStreamState("loading");
    setStreamFeedback("正在切换摄像头…");
    try {
      const result = await visionRequest(
        `/sessions/${encodeURIComponent(status.sessionId)}/camera`,
        {
          method: "POST",
          body: JSON.stringify({
            cameraId: `camera-${nextCameraIndex}`,
            cameraIndex: Number(nextCameraIndex),
          }),
        },
      );
      setStatus(result.data);
      setSelectedYoloModel(result.data.yoloModel || selectedYoloModel);
      captureServerTime(result);
      setStreamRetry((current) => current + 1);
      setFeedback("摄像头已切换，视频保持开启。");
    } catch (error) {
      setCameraIndex(previousCameraIndex);
      setFeedback(error.message);
    } finally {
      setSwitchingCamera(false);
    }
  }

  async function changeTargetDevice(event) {
    const nextTargetDeviceId = event.target.value;
    onTargetDeviceChange(nextTargetDeviceId);
    if (!running) return;
    try {
      const result = await visionRequest(
        `/sessions/${encodeURIComponent(status.sessionId)}/target`,
        {
          method: "POST",
          body: JSON.stringify({ targetDeviceId: nextTargetDeviceId }),
        },
      );
      setStatus(result.data);
      setFeedback(nextTargetDeviceId ? "目标机器鱼已绑定。" : "已取消目标机器鱼，当前只预览和识别。");
    } catch (error) {
      onTargetDeviceChange(targetDeviceId);
      setFeedback(error.message);
    }
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

  function commitExposurePercent(percent) {
    const value = legalExposureValue(percent);
    if (!running || value === null || exposurePendingRef.current === value) return;
    exposurePendingRef.current = value;
    sendAction(
      { type: "camera.exposure", mode: "absolute", value },
      false,
    ).catch((error) => {
      exposurePendingRef.current = null;
      setFeedback(error.message);
    });
  }

  function normalizeExposureMax() {
    if (!exposureRangeReady) return;
    const value = Number(exposureMaxInput);
    const normalized = Number.isFinite(value)
      ? snapExposureValue(value)
      : exposureDriverMax;
    setExposureMaxInput(String(normalized));
    setExposurePercent((current) => Math.min(100, Math.max(0, current)));
  }

  async function toggleProcessing() {
    try {
      const result = await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}/processing`, { method: processing ? "DELETE" : "POST" });
      setStatus(result.data);
      setTool("");
      setFeedback(processing ? "视觉处理已停止，保留预览" : "视觉处理已启动");
    } catch (error) { setFeedback(error.message); }
  }

  async function setOverlay(key, enabled) {
    const next = { ...overlays, [key]: enabled };
    setOverlayPrefs(next);
    try {
      if (!status.sessionId || !running) return;
      await sendAction({ type: "overlay.set", overlays: next }, false);
      setStatus((current) => ({ ...current, metrics: { ...(current.metrics || {}), overlays: next } }));
      setFeedback(`${key === "detections" ? "YOLO 识别" : "路径"}已${enabled ? "显示" : "屏蔽"}`);
    } catch (error) {
      setFeedback(error.message);
    }
  }

  async function selectTool(nextTool) {
    const { activeTool, actionType } = transitionVisionTool(tool, nextTool);
    setTool(activeTool);
    if (actionType) await sendAction({ type: actionType });
    setFeedback(activeTool ? `${TOOLS.find(([name]) => name === activeTool)?.[1] || "画布工具"}模式` : "画布工具已关闭");
  }

  function pointFrom(event) {
    const image = imageRef.current;
    const mediaWidth = image.videoWidth || image.naturalWidth || videoWidth;
    const mediaHeight = image.videoHeight || image.naturalHeight || videoHeight;
    return toVideoPoint(event, image.getBoundingClientRect(), videoWidth, videoHeight, mediaWidth, mediaHeight);
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
    if ((point.x - last.x) ** 2 + (point.y - last.y) ** 2 >= 16) setDrag({ ...drag, points: [...drag.points, point] });
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
    <section className={`vision-card panel-surface ${manual ? "manual-mode" : ""}`} aria-label={manual ? "视频监看" : "视觉控制"}>
      <header className="vision-header">
        <div><span className="eyebrow">{manual ? "DRIVER VIEW" : "FISH VISION"}</span><h2>{manual ? "视频监看" : "视觉识别"}</h2><small>{manual ? "手动和视觉模式共用当前视频会话" : "摄像头画面、YOLO 识别框、跟踪结果"}</small></div>
        <div className="vision-header-status">
          <span className={`status ${running ? "online" : "offline"}`}><i />{running ? "运行中" : "已停止"}</span>
          <span className={`status ${yolo?.ready ? "online" : "offline"}`}><i />{yoloLabel}</span>
          {running && <span className="status online"><i />{coordinateLabel}</span>}
        </div>
      </header>
      <div className="vision-setup-bar">
        {!manual && showTargetDeviceSelector && <label className="camera-select">视觉目标设备<select value={targetDeviceId} disabled={switchingCamera} onChange={changeTargetDevice}><option value="">不指定目标鱼（仅预览/识别）</option>{devices.filter((device) => device.online).map((device) => <option key={device.deviceId} value={device.deviceId}>{device.name || device.deviceId} · {device.deviceId}</option>)}</select><small className="camera-hint">{targetDeviceId ? "自动/循迹会控制所选机器鱼" : "无鱼在线也可以先开启摄像头预览和视觉识别"}</small></label>}
        <label className="camera-select">摄像头<select value={cameraIndex} disabled={switchingCamera} onChange={changeCamera}><option value="">请选择摄像头</option>{cameras.map((camera) => <option key={camera.index} value={camera.index}>{cameraLabel(camera)}</option>)}</select><small className="camera-hint">{selectedCamera ? cameraLabel(selectedCamera) : "选择要用于视觉识别的 USB 摄像头"}</small></label>
        {!manual && <label className="camera-select">YOLO 模型<select value={selectedYoloModel} disabled={running || switchingCamera || !yoloModels.length} onChange={(event) => setSelectedYoloModel(event.target.value)}><option value="">{yoloModels.length ? "请选择 .pt 模型" : "未找到 .pt 模型"}</option>{yoloModels.map((model) => <option key={model} value={model}>{model}</option>)}</select><small className="camera-hint">{running ? `当前会话：${status.yoloModel || selectedYoloModel || "默认模型"}` : "选择本地 vision/assets 下的 .pt 模型"}</small></label>}
        <div className="vision-primary setup-actions"><button disabled={running || cameraIndex === "" || switchingCamera} onClick={start}>{running ? "视频已开启" : "开始预览"}</button><button disabled={!running || switchingCamera} onClick={toggleProcessing}>{processing ? "停止识别" : "启动识别"}</button><button className="stop" disabled={!running || switchingCamera} onClick={stop}>关闭视频</button></div>
      </div>
      <div className="vision-layout">
        <div className="shared-video-stage video-stage" style={{ "--video-aspect": `${videoWidth} / ${videoHeight}` }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
          {running ? <>
            <VideoStream
              ref={imageRef}
              sessionId={status.sessionId}
              retry={streamRetry}
              onError={reconnectStream}
              onReady={streamConnected}
              onTransportError={(error) => setStreamFeedback(`${error?.message || "WebRTC 暂不可用"}，正在重连。`)}
              alt="机器鱼视觉处理画面"
            />
            {streamState !== "ready" && <div className={`video-stream-status ${streamState}`}>
              <strong>{streamState === "error" ? "视频流暂时不可用" : "正在连接视频流…"}</strong>
              <span>{streamState === "error" ? (sessionErrorMessage(status) || "摄像头未返回可显示画面，正在自动重试") : "请稍候，摄像头画面即将出现"}</span>
            </div>}
          </> : <div className={`video-placeholder ${status.state === "error" ? "has-error" : ""}`}><strong>{status.state === "error" ? "摄像头启动失败" : "视觉画面未启动"}</strong><span>{sessionErrorMessage(status) || "选择摄像头后开始预览"}</span></div>}
          {running && <div className="video-badge">服务器 {serverClock}<br />本机 {clock}{latencyLabel}<br />{videoWidth} × {videoHeight}</div>}
        </div>
        {manual ? <aside className="vision-controls manual-video-controls-panel">
          <div className="vision-control-head"><h2>视频设置</h2><small>摄像头、曝光和识别框在两个模式中保持一致</small></div>
          {sharedOverlayPanel}
          {sharedExposurePanel}
          <p className="feedback manual-shared-feedback" aria-live="polite">{streamFeedback || feedback || (running ? `摄像头 ${status.cameraIndex} · ${yoloLabel}` : "视频服务未启动")}</p>
        </aside> : <aside className="vision-controls">
          <div className="vision-control-head"><h2>识别状态</h2><small>当前：{controlModeLabel}</small></div>
          <section className="vision-targets"><strong>检测目标 · {detections.length}</strong>{detections.length ? detections.map((target) => <div key={target.trackId}><i style={{ background: target.colorHex }} /><span>目标 #{target.trackId}</span><b>{target.color}</b><small>{Math.round(target.confidence * 100)}%</small></div>) : <p>{processing ? "暂未检测到机器鱼" : "启动视觉处理后显示目标"}</p>}</section>
          {sharedOverlayPanel}
          <section className="vision-mode-panel">
            <div className="mode-grid">{CONTROL_MODES.map(([name, label, description]) => <button key={name} type="button" className={controlMode === name ? "active" : ""} aria-pressed={controlMode === name} onClick={() => { setControlMode(name); setFeedback(`视觉模式：${description}`); }}>{label}</button>)}</div>
            <div className="param-panel auto-param-panel" aria-label="自动控制参数">
              <div className="param-title">自动控制参数 <span>限速 {autoSpeed} · 幅度 {autoAmplitude} · 置信 {autoConfidence}</span></div>
              <label className="slider-row"><span>限速</span><input type="range" min="0" max="100" value={autoSpeed} onChange={(event) => setAutoSpeed(Number(event.target.value))} /><output>{autoSpeed}%</output></label>
              <label className="slider-row"><span>最大幅度</span><input type="range" min="0" max="90" value={autoAmplitude} onChange={(event) => setAutoAmplitude(Number(event.target.value))} /><output>{autoAmplitude}°</output></label>
              <label className="slider-row"><span>置信度</span><input type="range" min="50" max="99" value={autoConfidence} onChange={(event) => setAutoConfidence(Number(event.target.value))} /><output>{autoConfidence}%</output></label>
            </div>
            <p className="logic-box"><strong>控制逻辑</strong>只识别不会下发运动；辅助/自动模式仍受控制权、限速、限幅约束，正式运动由循迹启动按钮接管。未选择目标鱼时只运行预览和识别。</p>
          </section>
          {sharedExposurePanel}
          <section className={`vision-workflow ${workflow.trackingActive ? "active" : ""}`}>
            <header><strong>循迹流程</strong><span>{workflowLabel}</span></header>
            <div>{WORKFLOW_STAGES.map(([key, label], index) => {
              const complete = Boolean(workflow[key]);
              const current = !complete && WORKFLOW_STAGES.slice(0, index).every(([previous]) => workflow[previous]);
              return <p key={key} className={complete ? "complete" : current ? "current" : "pending"}><i>{complete ? "✓" : index + 1}</i><span>{label}</span><b>{complete ? "完成" : current ? "待处理" : "等待"}</b></p>;
            })}</div>
            {workflow.blockers?.length > 0 && <small>{workflow.blockers[0]}</small>}
            {workflow.headingCalibration && <div className={`heading-calibration-progress ${workflow.headingCalibration.status || "idle"}`}><span><b>方向采样</b><em>{workflow.headingCalibration.sampleCount || 0} 帧 · {Math.round((workflow.headingCalibration.progress || 0) * 100)}%</em></span><progress max="1" value={workflow.headingCalibration.progress || 0} /><small>{workflow.headingCalibration.message || "等待开始"}</small></div>}
          </section>
          <div className="tool-grid">{TOOLS.map(([name, label]) => <button key={name} className={tool === name ? "active" : ""} disabled={!editable} onClick={() => selectTool(name)}>{label}</button>)}</div>
          <div className="tool-grid compact">
            <button disabled={!running || !workflow.canCalibrateHeading} onClick={() => sendAction({ type: "heading.calibrate" })}>{workflow.headingCalibrating ? "方向标定中" : "方向标定"}</button>
            <button disabled={!running} onClick={() => sendAction({ type: "path.clear" })}>清除轨迹</button>
            <button disabled={!running} onClick={() => sendAction({ type: "recording.toggle" })}>录像</button>
            <button disabled={!running} onClick={() => sendAction({ type: "snapshot.capture" })}>截图</button>
          </div>
          <div className="tracking-actions"><button disabled={!running || !workflow.canStart || targetRequiredForMotion} onClick={() => sendAction({ type: "tracking.start" })}>{targetRequiredForMotion ? "选择鱼后循迹" : workflow.headingCalibrating ? "方向标定中" : workflow.trackingActive ? "循迹运行中" : "启动循迹"}</button><button className="stop" disabled={!running} onClick={() => sendAction({ type: "tracking.stop" })}>停止循迹</button></div>
          <p className="feedback" aria-live="polite">{streamFeedback || feedback || yolo?.error || yolo?.lastInferenceError || (running ? `摄像头 ${status.cameraIndex} 正在处理 · ${yoloLabel} · ${coordinateLabel}` : "视觉服务未启动")}</p>
        </aside>}
      </div>
    </section>
  );
}
