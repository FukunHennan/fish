import { createExposureSync } from "./exposureSync.js";
import { useEffect, useRef, useState } from "react";
import { chooseCameraIndex, toVideoPoint } from "./coordinates.js";
import { transitionVisionTool } from "./visionTools.js";
import { canEditVision, visionEventUrl, visionRequest as rootVisionRequest } from "./visionSession.js";
import { CONTROL_CLIENT_ID, leaseIsMine } from "./ui/devicePresentation.js";
import { formatFrameLatency, formatServerClock, formatVideoClock } from "./videoTime.js";
import VideoStream from "./VideoStream.jsx";

const TOOLS = [
  ["path", "绘制轨迹"],
  ["calibration", "场地测量标定（可选）"],
];

const WORKFLOW_STAGES = [
  ["targetDetected", "单鱼目标"],
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

const TRACKING_MODES = [
  ["yolo", "YOLO 模式", "保留多目标约束，适合通用场景"],
  ["single_fish", "单鱼循迹", "默认池里只有一条鱼，放宽多目标阻塞"],
];

const DEFAULT_OVERLAYS = { detections: false, paths: false };
const EXPOSURE_USER_MAX = 1000;

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

function browserCameraLabel(camera, index) {
  const label = camera.label || `本机摄像头 ${index + 1}`;
  return /integrated|built[- ]?in|内置|facetime/i.test(label)
    ? `${label} · 电脑自带`
    : label;
}

export default function VisionPanel({
  isAdmin = false,
  user = null,
  devices = [],
  targetDeviceId = "",
  targetTrackId = null,
  onTargetDeviceChange = () => {},
  onTargetTrackChange = () => {},
  onVisionStateChange = () => {},
  onClaimDevice = async () => false,
  mode = "vision",
  showTargetDeviceSelector = true,
  showControls = true,
}) {
  const controlledFish = devices.find((fish) => fish.deviceId === targetDeviceId);
  const workspacePrefix = targetDeviceId && leaseIsMine(controlledFish?.lease, user)
    ? `/workspaces/${encodeURIComponent(targetDeviceId)}` : "";
  const workspaceHeaders = workspacePrefix ? { "X-Fish-Client": CONTROL_CLIENT_ID } : {};
  const workspaceRef = useRef(workspacePrefix);
  const workspaceChanged = workspaceRef.current !== workspacePrefix;
  workspaceRef.current = workspacePrefix;
  const visionRequest = (path, options = {}) => rootVisionRequest(`${workspacePrefix}${path}`, {
    ...options, headers: { ...workspaceHeaders, ...(options.headers || {}) },
  });
  const sharedVisionRequest = (path, options = {}) => rootVisionRequest(path, options);
  const [cameras, setCameras] = useState([]);
  const [cameraIndex, setCameraIndex] = useState("");
  const [cameraSource, setCameraSource] = useState("server");
  const [browserCameras, setBrowserCameras] = useState([]);
  const [browserDeviceId, setBrowserDeviceId] = useState("");
  const [browserStream, setBrowserStream] = useState(null);
  const [browserCameraBusy, setBrowserCameraBusy] = useState(false);
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
  const [trackingMode, setTrackingMode] = useState("single_fish");
  const [overlayPrefs, setOverlayPrefs] = useState(DEFAULT_OVERLAYS);
  const [clock, setClock] = useState(() => formatVideoClock());
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [serverTime, setServerTime] = useState(null);
  const [serverUtcOffsetMinutes, setServerUtcOffsetMinutes] = useState(0);
  const [serverTimeReceivedAt, setServerTimeReceivedAt] = useState(0);
  const [exposurePercent, setExposurePercent] = useState(50);
  const [videoToggleBusy, setVideoToggleBusy] = useState(false);
  const [cropRegion, setCropRegion] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const [cropDraft, setCropDraft] = useState(null);
  const [cropSelecting, setCropSelecting] = useState(false);
  const cropStart = useRef(null);
  const browserVideoRef = useRef(null);
  const localPreview = cameraSource === "browser";
  useEffect(() => { fetch("/api/vision/crop").then(r => r.ok ? r.json() : null).then(value => { if (value) setCropRegion(value); }).catch(() => {}); }, []);
  async function applyCrop(value) {
    try {
      const response = await fetch("/api/vision/crop", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "裁剪失败");
      setCropRegion(result); setCropDraft(null); setCropSelecting(false);
      const state = await sessionRequest("/sessions/current");
      setStatus(state.data || state);
      setFeedback("裁剪已应用，请重新确认目标并进行场地标定");
    } catch (error) { setFeedback(error.message); }
  }
  const [viewQuality, setViewQuality] = useState("smooth");
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [workspaceSessionReady, setWorkspaceSessionReady] = useState(!workspacePrefix);
  const [exposureMaxInput, setExposureMaxInput] = useState(String(EXPOSURE_USER_MAX));
  const imageRef = useRef(null);
  const retryTimerRef = useRef(null);
  const exposurePendingRef = useRef(createExposureSync());
  const exposureTimerRef = useRef(null);
  useEffect(() => {
    exposurePendingRef.current = createExposureSync();
    return () => window.clearTimeout(exposureTimerRef.current);
  }, [status.sessionId, status.cameraIndex]);
  const camerasRef = useRef([]);
  const targetDeviceIdRef = useRef(targetDeviceId);
  const targetTrackIdRef = useRef(targetTrackId);
  const autoClaimedDeviceRef = useRef("");

  const manual = mode === "manual";
  const running = ["previewing", "processing", "tracking"].includes(status.state);
  const processing = ["processing", "tracking"].includes(status.state);
  const editable = canEditVision(status);
  const sessionRequest = workspacePrefix ? visionRequest : sharedVisionRequest;
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
  const activeTrackingMode = workflow.trackingMode || trackingMode;
  const singleFishMode = activeTrackingMode === "single_fish";
  const onlineFish = devices.filter((fish) => fish.online);
  const autoTargetDeviceId = singleFishMode && !targetDeviceId && onlineFish.length === 1
    ? onlineFish[0].deviceId
    : "";
  const effectiveTargetDeviceId = targetDeviceId || status.targetDeviceId || autoTargetDeviceId;
  const trackingModeLabel = TRACKING_MODES.find(([name]) => name === activeTrackingMode)?.[1] || "单鱼循迹";
  const selectedTrackId = targetTrackId ?? status.targetTrackId ?? null;
  const selectedDetection = detections.find((target) => target.trackId === selectedTrackId);
  const singleFishDetected = Boolean(workflow.targetDetected) || Boolean(yolo?.targetFound) || detections.length > 0;
  const targetRequiredForMotion = (
    !effectiveTargetDeviceId
    || (!singleFishMode && Number(yolo?.detectionCount) > 1 && selectedTrackId === null)
    || (!singleFishMode && selectedTrackId !== null && !yolo?.targetFound && processing)
  );

  useEffect(() => {
    if (
      mode === "manual"
      || !running
      || !singleFishMode
      || targetDeviceId
      || !autoTargetDeviceId
      || autoClaimedDeviceRef.current === autoTargetDeviceId
    ) return undefined;
    const device = onlineFish.find((fish) => fish.deviceId === autoTargetDeviceId);
    if (!device) return undefined;
    autoClaimedDeviceRef.current = autoTargetDeviceId;
    let active = true;
    (async () => {
      const claimed = await onClaimDevice(device);
      if (active && claimed) {
        onTargetDeviceChange(autoTargetDeviceId);
        setFeedback("单鱼模式已自动恢复当前机器鱼控制权。");
      } else if (active) {
        autoClaimedDeviceRef.current = "";
      }
    })().catch(() => {
      if (active) autoClaimedDeviceRef.current = "";
    });
    return () => { active = false; };
  }, [
    autoTargetDeviceId,
    mode,
    onClaimDevice,
    onTargetDeviceChange,
    onlineFish,
    running,
    singleFishMode,
    targetDeviceId,
  ]);
  const exposure = status.metrics?.exposure || {};
  const controlModeLabel = "自动控制";
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
    const bounded = Math.min(
      exposureDriverMax,
      EXPOSURE_USER_MAX,
      Math.max(exposureMin, Number(value)),
    );
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
      <header><strong>画面显示</strong></header>
      <div className="overlay-toggle-row compact">
        <label><input type="checkbox" role="switch" checked={overlays.detections} disabled={!running} onChange={(event) => setOverlay("detections", event.target.checked)} /> YOLO 识别</label>
        <label><input type="checkbox" role="switch" checked={overlays.paths} disabled={!running} onChange={(event) => setOverlay("paths", event.target.checked)} /> 路径/轨迹</label>
      </div>
    </section>
  );

  const sharedExposurePanel = (
    <section className="exposure-control">
      <div className="exposure-inline">
      <label className="exposure-slider-row">
        <span>曝光</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={exposurePercent}
          disabled={!running || !exposureRangeReady}
          onPointerDown={() => exposurePendingRef.current.begin()}
          onPointerCancel={() => { exposurePendingRef.current.editing = false; }}
          onChange={(event) => { exposurePendingRef.current.begin(); setExposurePercent(Number(event.target.value)); }}
          onPointerUp={(event) => commitExposurePercent(event.currentTarget.value)}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
              commitExposurePercent(event.currentTarget.value);
            }
          }}
          onBlur={(event) => commitExposurePercent(event.currentTarget.value)}
          aria-label="曝光百分比"
        />
        <output title={`目标值 ${previewExposureValue ?? "—"} · 实际值 ${exposure.actualValue ?? "—"}`}>{Math.round(exposurePercent)}%</output>
      </label>
      <label className="exposure-limit-row">
        <span>上限</span>
          <input
            type="number"
            min={exposureRangeReady ? exposureMin : undefined}
            max={exposureRangeReady ? Math.min(exposureDriverMax, EXPOSURE_USER_MAX) : undefined}
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
      </div>
      {exposure.errorCode && <small role="status">{exposureHelp}</small>}
    </section>
  );

  useEffect(() => { if (status.metrics?.crop) setCropRegion(status.metrics.crop); }, [status.metrics?.crop]);

  useEffect(() => {
    if (browserVideoRef.current) browserVideoRef.current.srcObject = browserStream;
    if (browserStream) browserVideoRef.current?.play().catch(() => {});
  }, [browserStream]);

  useEffect(() => () => {
    browserStream?.getTracks().forEach((track) => track.stop());
  }, [browserStream]);

  async function refreshBrowserCameras(requestPermission = false) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      throw new Error("当前浏览器不支持本机摄像头选择");
    }
    if (requestPermission && !browserStream) {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      permissionStream.getTracks().forEach((track) => track.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const next = devices.filter((device) => device.kind === "videoinput");
    setBrowserCameras(next);
    setBrowserDeviceId((current) => current && next.some((device) => device.deviceId === current)
      ? current : next[0]?.deviceId || "");
    return next;
  }

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return undefined;
    const refresh = () => refreshBrowserCameras(false).catch(() => {});
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, []);

  async function startBrowserCamera(deviceId = browserDeviceId) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持本机摄像头");
    setBrowserCameraBusy(true);
    try {
      browserStream?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false,
      });
      setBrowserStream(stream);
      const track = stream.getVideoTracks()[0];
      const actualDeviceId = track?.getSettings?.().deviceId || deviceId;
      setBrowserDeviceId(actualDeviceId || "");
      await refreshBrowserCameras(false);
      setFeedback("电脑摄像头预览已开启；识别和循迹仍使用服务器摄像头。");
    } finally {
      setBrowserCameraBusy(false);
    }
  }

  function stopBrowserCamera() {
    browserStream?.getTracks().forEach((track) => track.stop());
    setBrowserStream(null);
    setFeedback("电脑摄像头预览已关闭。");
  }

  async function selectCameraSource(event) {
    const nextSource = event.target.value;
    setCameraSource(nextSource);
    if (nextSource !== "browser") {
      stopBrowserCamera();
      setFeedback("已切换到服务器摄像头；识别和循迹使用服务器采集画面。");
      return;
    }
    try {
      const available = await refreshBrowserCameras(true);
      if (!available.length) throw new Error("未找到电脑摄像头");
      await startBrowserCamera(browserDeviceId || available[0].deviceId);
    } catch (error) {
      setCameraSource("server");
      setFeedback(error.message || "电脑摄像头无法开启");
    }
  }

  async function changeBrowserCamera(event) {
    const nextDeviceId = event.target.value;
    setBrowserDeviceId(nextDeviceId);
    try {
      await startBrowserCamera(nextDeviceId);
    } catch (error) {
      setFeedback(error.message || "电脑摄像头切换失败");
    }
  }

  function captureServerTime(payload) {
    const value = Number(payload?.serverTime ?? payload?.data?.serverTime);
    if (!Number.isFinite(value)) return;
    setServerTime(value);
    const offset = Number(payload?.serverUtcOffsetMinutes ?? payload?.data?.serverUtcOffsetMinutes);
    if (Number.isFinite(offset)) setServerUtcOffsetMinutes(offset);
    setServerTimeReceivedAt(Date.now());
  }

  useEffect(() => {
    setWorkspaceSessionReady(!workspacePrefix);
    let active = true;
    async function refresh() {
      try {
        const [cameraResponse, statusResponse] = await Promise.all([
          fetch("/api/vision/cameras", { cache: "no-store" }),
          fetch(`/api/vision${workspacePrefix}/sessions/current`, { cache: "no-store", headers: workspaceHeaders }),
        ]);
        if (cameraResponse.status === 401 || statusResponse.status === 401) {
          if (active) { setStatus({ state: "stopped", metrics: {} }); setStreamFeedback("登录已失效，请重新登录"); }
          throw new Error("登录已失效，请重新登录");
        }
        if (!cameraResponse.ok || !statusResponse.ok) throw new Error("视觉后台未就绪");
        const cameraList = await cameraResponse.json();
        const statusEnvelope = await statusResponse.json();
        const nextStatus = statusEnvelope.data || statusEnvelope;
        if (!active) return;
        camerasRef.current = cameraList;
        captureServerTime(statusEnvelope);
        setCameras(cameraList);
        setStatus(nextStatus);
        setWorkspaceSessionReady(true);
        setTrackingMode(nextStatus.trackingMode || "single_fish");
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
    const eventUrl = workspacePrefix
      ? `${visionEventUrl().replace("/events", `${workspacePrefix}/events`)}?clientId=${encodeURIComponent(CONTROL_CLIENT_ID)}`
      : visionEventUrl();
    const source = new window.EventSource(eventUrl);
    source.onerror = () => { if (active) refresh(); };
    source.addEventListener("session", (event) => {
      if (!active) return;
      try {
        const envelope = JSON.parse(event.data);
        const nextStatus = envelope.data || envelope;
        captureServerTime(envelope);
        setStatus(nextStatus);
        setWorkspaceSessionReady(true);
        setTrackingMode(nextStatus.trackingMode || "single_fish");
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
  }, [workspacePrefix]);

  useEffect(() => {
    if (workspaceChanged || (workspacePrefix && !workspaceSessionReady)) return undefined;
    if (
      (
        targetDeviceIdRef.current === targetDeviceId
        && targetTrackIdRef.current === selectedTrackId
      )
    ) return undefined;
    const previousTargetDeviceId = targetDeviceIdRef.current;
    const previousTargetTrackId = targetTrackIdRef.current;
    targetDeviceIdRef.current = targetDeviceId;
    targetTrackIdRef.current = selectedTrackId;
    if (!running || !status.sessionId) return undefined;
    let active = true;
    visionRequest(
      `/sessions/${encodeURIComponent(status.sessionId)}/target`,
      {
        method: "POST",
        body: JSON.stringify({
          targetDeviceId,
          targetTrackId: selectedTrackId,
        }),
      },
    ).then((result) => {
      if (!active) return;
      setStatus(result.data);
      setFeedback(targetDeviceId ? "目标机器鱼已绑定。" : "已取消目标机器鱼，当前只预览和识别。");
    }).catch((error) => {
      if (!active) return;
      targetDeviceIdRef.current = previousTargetDeviceId;
      targetTrackIdRef.current = previousTargetTrackId;
      onTargetDeviceChange(previousTargetDeviceId);
      onTargetTrackChange(previousTargetTrackId);
      setFeedback(error.message);
    });
    return () => { active = false; };
  }, [
    manual,
    onTargetDeviceChange,
    onTargetTrackChange,
    running,
    selectedTrackId,
    status.sessionId,
    targetDeviceId,
    workspacePrefix,
    workspaceSessionReady,
    workspaceChanged,
  ]);

  useEffect(() => {
    onVisionStateChange({
      state: status.state,
      sessionId: status.sessionId || null,
      targetDeviceId: status.targetDeviceId || targetDeviceId || "",
      targetTrackId: status.targetTrackId ?? selectedTrackId,
      metrics: status.metrics || {},
    });
  }, [manual, onVisionStateChange, selectedTrackId, status, targetDeviceId]);

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
    if (!exposurePendingRef.current.finish(action)) return;
    window.clearTimeout(exposureTimerRef.current);
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
    if (exposurePendingRef.current.blocked()) return;
    setExposureMaxInput((current) => {
      const currentValue = Number(current);
      if (!current || !Number.isFinite(currentValue)) {
        return String(Math.min(exposureDriverMax, EXPOSURE_USER_MAX));
      }
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
    setPreviewEnabled(true);
    if (running) return;
    try {
      if (cameraIndex === "") throw new Error("请选择摄像头");
      const payload = { cameraId: `camera-${cameraIndex}`, cameraIndex: Number(cameraIndex) };
      payload.trackingMode = trackingMode;
      if (effectiveTargetDeviceId) payload.targetDeviceId = effectiveTargetDeviceId;
      if (selectedTrackId !== null) payload.targetTrackId = selectedTrackId;
      if (selectedYoloModel) payload.yoloModel = selectedYoloModel;
      const result = await sessionRequest("/sessions", { method: "POST", body: JSON.stringify(payload) });
      setStatus(result.data);
      setTrackingMode(result.data.trackingMode || trackingMode);
      setSelectedYoloModel(result.data.yoloModel || selectedYoloModel);
      captureServerTime(result);
      setFeedback(effectiveTargetDeviceId ? "摄像头预览已启动，已绑定目标鱼" : "摄像头预览已启动；未选择目标鱼，仅预览/识别");
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
      const result = await sessionRequest(
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
      setTrackingMode(result.data.trackingMode || trackingMode);
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
    if (nextTargetDeviceId !== targetDeviceId) onTargetTrackChange(null);
    onTargetDeviceChange(nextTargetDeviceId);
    setFeedback(nextTargetDeviceId ? "正在绑定视觉目标设备…" : "正在取消设备绑定…");
  }

  function changeTargetTrack(trackId) {
    const nextTrackId = selectedTrackId === trackId ? null : trackId;
    onTargetTrackChange(nextTrackId);
    setFeedback(
      nextTrackId === null
        ? "已取消目标锁定；当前只识别，不会自动控制。"
        : `已选择目标 #${nextTrackId}，正在切换视觉目标…`,
    );
  }

  async function changeTrackingMode(nextMode) {
    if (nextMode === trackingMode || switchingCamera) return;
    if (nextMode === "single_fish" && selectedTrackId !== null) onTargetTrackChange(null);
    if (!running || !status.sessionId) {
      setTrackingMode(nextMode);
      setFeedback(nextMode === "single_fish" ? "已选择单鱼循迹模式，启动预览时生效" : "已选择 YOLO 模式，启动预览时生效");
      return;
    }
    try {
      await sendAction({ type: "tracking.mode", mode: nextMode });
      setTrackingMode(nextMode);
      setFeedback(nextMode === "single_fish" ? "已选择单鱼循迹模式" : "已选择 YOLO 模式");
    } catch (error) {
      setFeedback(error.message);
    }
  }

  async function stop() {
    setPreviewEnabled(false);
    window.clearTimeout(retryTimerRef.current);
    setStreamFeedback("");
    setFeedback("已关闭本机预览，其他客户端不受影响");
  }

  async function sendAction(action, report = true) {
    const actionId = action.actionId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const result = await visionRequest(`/sessions/${encodeURIComponent(status.sessionId)}/actions`, { method: "POST", body: JSON.stringify({ ...action, actionId }) });
    if (report) setFeedback(result.data.accepted ? "操作已确认" : "操作未接受");
    return result;
  }

  function commitExposurePercent(percent) {
    const value = legalExposureValue(percent);
    const sync = exposurePendingRef.current;
    const edited = sync.editing;
    sync.editing = false;
    if (!running || value === null || sync.pending?.value === value || !edited) return;
    const actionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    sync.submit(actionId, value);
    window.clearTimeout(exposureTimerRef.current);
    exposureTimerRef.current = window.setTimeout(() => {
      if (sync.fail(actionId)) setFeedback("曝光确认超时，请重试");
    }, 5000);
    sendSharedAction({ type: "camera.exposure", mode: "absolute", value, actionId }, false)
      .then((result) => {
        if (result.data.accepted === false) throw new Error("曝光设置未接受");
      })
      .catch((error) => {
        if (exposurePendingRef.current === sync && sync.fail(actionId)) {
          window.clearTimeout(exposureTimerRef.current);
          setFeedback(error.message);
        }
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
      // Camera processing is shared by manual and vision views. Workspace
      // sessions have a different id, so resolve the shared session first.
      const sharedCurrent = await sharedVisionRequest("/sessions/current");
      const sharedSession = sharedCurrent.data || sharedCurrent;
      if (!sharedSession.sessionId) throw new Error("共享视觉会话尚未建立");
      const result = await sharedVisionRequest(
        `/sessions/${encodeURIComponent(sharedSession.sessionId)}/processing`,
        { method: processing ? "DELETE" : "POST" },
      );
      const current = workspacePrefix
        ? await visionRequest("/sessions/current")
        : result;
      const nextStatus = current.data || current;
      setStatus(nextStatus);
      setTrackingMode(nextStatus.trackingMode || trackingMode);
      setTool("");
      setFeedback(processing ? "视觉处理已停止，保留预览" : "视觉处理已启动");
    } catch (error) { setFeedback(error.message); }
  }

  async function sendSharedAction(action, report = true) {
    const actionId = action.actionId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const sharedCurrent = await sharedVisionRequest("/sessions/current");
    const sharedSession = sharedCurrent.data || sharedCurrent;
    if (!sharedSession.sessionId) throw new Error("共享视觉会话尚未建立");
    const result = await sharedVisionRequest(`/sessions/${encodeURIComponent(sharedSession.sessionId)}/actions`, {
      method: "POST",
      body: JSON.stringify({ ...action, actionId }),
    });
    if (report) setFeedback(result.data.accepted ? "操作已确认" : "操作未接受");
    return result;
  }

  async function setOverlay(key, enabled) {
    const next = { ...overlays, [key]: enabled };
    setOverlayPrefs(next);
    try {
      if (!status.sessionId || !running) return;
      await (workspacePrefix ? sendAction : sendSharedAction)({ type: "overlay.set", overlays: next }, false);
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
    const image = localPreview ? browserVideoRef.current : imageRef.current;
    if (!image) return { x: 0, y: 0 };
    const mediaWidth = image.videoWidth || image.naturalWidth || videoWidth;
    const mediaHeight = image.videoHeight || image.naturalHeight || videoHeight;
    return toVideoPoint(event, image.getBoundingClientRect(), videoWidth, videoHeight, mediaWidth, mediaHeight);
  }

  function beginCanvasInput(event) {
    if (cropSelecting && isAdmin && running && !processing) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      cropStart.current = pointFrom(event); return;
    }
    if (!tool || (tool !== "path" && !editable)) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = pointFrom(event);
    if (tool === "path") setDrag({ start: point, points: [point] });
    else if (tool === "marker") setDrag({ start: point, points: [point] });
  }

  function moveCanvasInput(event) {
    if (cropSelecting && cropStart.current) {
      const p = pointFrom(event), a = cropStart.current;
      setCropDraft({ x: cropRegion.x + Math.min(a.x,p.x)/videoWidth*cropRegion.width,
        y: cropRegion.y + Math.min(a.y,p.y)/videoHeight*cropRegion.height,
        width: Math.abs(a.x-p.x)/videoWidth*cropRegion.width,
        height: Math.abs(a.y-p.y)/videoHeight*cropRegion.height }); return;
    }
    if (!drag || tool !== "path") return;
    const point = pointFrom(event);
    const last = drag.points[drag.points.length - 1];
    if ((point.x - last.x) ** 2 + (point.y - last.y) ** 2 >= 16) setDrag({ ...drag, points: [...drag.points, point] });
  }

  async function finishCanvasInput(event) {
    if (cropSelecting) { moveCanvasInput(event); cropStart.current = null; return; }
    if (!tool || (tool !== "path" && !editable)) return;
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
    <section className={`vision-card panel-surface ${manual ? "manual-mode" : ""} ${showControls ? "" : "stage-only"}`} aria-label={manual ? "视频监看" : "视觉控制"}>
      <header className="vision-header">
        <div><h2>视频</h2></div>
        <div className="vision-header-status">
          <span className={`status ${running ? "online" : "offline"}`}><i />{running ? "运行中" : "已停止"}</span>
          <span className={`status ${yolo?.ready ? "online" : "offline"}`}><i />{yoloLabel}</span>
          {running && <span className="status online"><i />{coordinateLabel}</span>}
        </div>
      </header>
      <details className="video-common-settings"><summary>视频设置</summary>
        <label className="range-row"><span>画面来源</span><select aria-label="画面来源" value={cameraSource} disabled={browserCameraBusy} onChange={selectCameraSource}><option value="server">服务器摄像头 · 识别/循迹</option><option value="browser">电脑摄像头 · 本机预览</option></select></label>
        {localPreview && <label className="range-row"><span>电脑摄像头</span><select aria-label="电脑摄像头" value={browserDeviceId} disabled={browserCameraBusy || !browserCameras.length} onChange={changeBrowserCamera}><option value="">请选择电脑摄像头</option>{browserCameras.map((camera, index) => <option key={camera.deviceId || `browser-${index}`} value={camera.deviceId}>{browserCameraLabel(camera, index)}</option>)}</select></label>}
        <label className="range-row"><span>本机清晰度</span><select aria-label="本机观看清晰度" value={viewQuality} onChange={event => setViewQuality(event.target.value)}><option value="smooth">流畅 · 640</option><option value="hd">高清 · 1280</option><option value="full">超清 · 1920</option></select></label>
      {isAdmin && <details><summary>识别区域裁剪</summary>
        <small>共享设置。先关闭识别；裁剪后重新标定场地。</small>
        <button type="button" disabled={!running || processing} onClick={() => { setCropSelecting(!cropSelecting); setCropDraft(null); }}> {cropSelecting ? "取消框选" : "在视频上框选"} </button>
        <button type="button" disabled={!cropDraft || processing} onClick={() => applyCrop(cropDraft)}>应用裁剪</button>
        <button type="button" disabled={processing} onClick={() => applyCrop({x:0,y:0,width:1,height:1})}>恢复全画面</button>
        {cropDraft && <small>已选择宽 {Math.round(cropDraft.width*100)}%、高 {Math.round(cropDraft.height*100)}%</small>}
      </details>}
      <div className="vision-setup-bar">

        <label className="camera-select">服务器摄像头<select value={cameraIndex} disabled={localPreview || switchingCamera} onChange={changeCamera}><option value="">请选择服务器摄像头</option>{cameras.map((camera) => <option key={camera.index} value={camera.index}>{cameraLabel(camera)}</option>)}</select><small className="camera-hint">用于共享视频、识别和循迹；电脑摄像头请在“视频设置”中选择。</small></label>
        {<label className="camera-select">YOLO 模型<select value={selectedYoloModel} disabled={running || switchingCamera || !yoloModels.length} onChange={(event) => setSelectedYoloModel(event.target.value)}><option value="">{yoloModels.length ? "请选择 .pt 模型" : "未找到 .pt 模型"}</option>{yoloModels.map((model) => <option key={model} value={model}>{model}</option>)}</select><small className="camera-hint">{running ? `当前会话：${status.yoloModel || selectedYoloModel || "默认模型"}` : "选择本地 vision/assets 下的 .pt 模型"}</small></label>}
        <div className="video-switches">
          <label className="video-switch-row"><span>{localPreview ? "电脑摄像头预览" : "服务器画面预览"}<small>{localPreview ? (browserStream ? "已开启" : "已关闭") : (running && previewEnabled ? "已开启" : "已关闭")}</small></span>
            <input type="checkbox" role="switch" aria-label="本机预览开关"
              disabled={browserCameraBusy || switchingCamera || videoToggleBusy || (localPreview ? !browserDeviceId : (!running && cameraIndex === ""))}
              checked={localPreview ? Boolean(browserStream) : Boolean(running && previewEnabled)}
              onChange={async () => { setVideoToggleBusy(true); try { if (localPreview) { browserStream ? stopBrowserCamera() : await startBrowserCamera(browserDeviceId); } else { await (running && previewEnabled ? stop() : start()); } } finally { setVideoToggleBusy(false); } }} />
          </label>
          <label className="video-switch-row"><span>{workspacePrefix ? "识别（服务器统一）" : "识别（共享）"}<small>{processing ? "运行中" : "未开启"}</small></span>
            <input type="checkbox" role="switch" aria-label="识别开关" checked={processing}
              disabled={!running || switchingCamera || videoToggleBusy}
              onChange={async () => { setVideoToggleBusy(true); try { await toggleProcessing(); } finally { setVideoToggleBusy(false); } }} />
          </label>
        </div>
      </div>
      {sharedExposurePanel}{sharedOverlayPanel}
      </details>
      <div className="vision-layout">
        {showTargetDeviceSelector && <aside className="vision-binding-rail" aria-label="识别对象与设备绑定">
          <div className="fish-binding-heading"><h2>在线机器鱼</h2><span>{devices.filter((fish) => fish.online).length} 台</span></div>
          <div className="fish-binding-list">
            {devices.filter((fish) => fish.online).map((fish) => {
              const active = fish.deviceId === targetDeviceId;
              const ownedHere = leaseIsMine(fish.lease, user);
              const confirmed = active && selectedTrackId !== null
                && status.targetDeviceId === fish.deviceId && status.targetTrackId === selectedTrackId;
              return <section key={fish.deviceId} className={`fish-binding-card ${active ? "selected" : ""}`}>
                <button type="button" className="fish-binding-select" aria-pressed={active}
                  disabled={switchingCamera} onClick={async () => {
                    if (!ownedHere && !(await onClaimDevice(fish))) return;
                    changeTargetDevice({ target: { value: fish.deviceId } });
                  }}>
                  <i className="signal online" /><span><strong>{fish.name || fish.deviceId}</strong><small>{fish.ip || fish.deviceId}</small></span>
                  <b>{active ? "已选" : ownedHere ? "可控制" : "领取"}</b>
                </button>
                {active && <div className="fish-binding-target">
                  {singleFishMode ? (
                    <span className="fish-binding-state" role="status">
                      {singleFishDetected ? "单鱼模式 · 自动跟踪当前鱼" : "单鱼模式 · 等待识别鱼"}
                    </span>
                  ) : (
                    <>
                      <label>识别目标
                        <select aria-label={`${fish.name || fish.deviceId}的识别目标`} value={selectedTrackId ?? ""} disabled={switchingCamera}
                          onChange={(event) => onTargetTrackChange(event.target.value === "" ? null : Number(event.target.value))}>
                          <option value="">不绑定目标</option>
                          {selectedTrackId !== null && !detections.some((target) => target.trackId === selectedTrackId) && <option value={selectedTrackId}>目标 #{selectedTrackId} · 暂时丢失</option>}
                          {detections.map((target) => <option key={target.trackId} value={target.trackId}>目标 #{target.trackId} · {target.color} · {Math.round(target.confidence * 100)}%</option>)}
                        </select>
                      </label>
                      <span className="fish-binding-state" role="status">{selectedTrackId !== null
                        ? !selectedDetection ? "目标暂时丢失" : confirmed ? `已绑定目标 #${selectedTrackId}` : "等待绑定确认"
                        : status.targetDeviceId === fish.deviceId && status.targetTrackId != null
                          ? "正在取消绑定…"
                          : detections.length ? "未绑定 · 可手动控制" : "未绑定 · 暂无识别目标"}</span>
                    </>
                  )}
                </div>}
              </section>;
            })}
            {!devices.some((fish) => fish.online) && <p className="rail-empty">暂无在线机器鱼</p>}
          </div>
          {devices.some((fish) => !fish.online) && <details className="offline-fish-list"><summary>离线设备 · {devices.filter((fish) => !fish.online).length}</summary>
            {devices.filter((fish) => !fish.online).map((fish) => <div key={fish.deviceId}>{fish.name || fish.deviceId}<small>离线</small></div>)}
          </details>}
        </aside>}
        <div className="shared-video-stage video-stage" style={{ "--video-aspect": `${videoWidth} / ${videoHeight}` }}
          onPointerDown={beginCanvasInput} onPointerMove={moveCanvasInput} onPointerUp={finishCanvasInput}
          onMouseDown={beginCanvasInput} onMouseMove={moveCanvasInput} onMouseUp={finishCanvasInput}>
          {cropSelecting && cropDraft && <div style={{ position:"absolute", zIndex:5, pointerEvents:"none", border:"2px solid #38bdf8", background:"#38bdf822", left:`${(cropDraft.x-cropRegion.x)/cropRegion.width*100}%`, top:`${(cropDraft.y-cropRegion.y)/cropRegion.height*100}%`, width:`${cropDraft.width/cropRegion.width*100}%`, height:`${cropDraft.height/cropRegion.height*100}%` }} />}
          {localPreview ? (browserStream ? <video ref={browserVideoRef} className="video-stream" autoPlay muted playsInline aria-label="电脑摄像头预览" /> : <div className="video-placeholder"><strong>电脑摄像头预览已关闭</strong><button type="button" disabled={videoToggleBusy || !browserDeviceId} onClick={() => startBrowserCamera(browserDeviceId)}>打开预览</button></div>) : !previewEnabled ? <div className="video-placeholder"><strong>本机预览已关闭</strong><button type="button" disabled={videoToggleBusy} onClick={start}>打开预览</button></div> : running ? <>
            <VideoStream
              ref={imageRef}
              sessionId={status.sessionId}
              workspacePrefix={workspacePrefix}
              clientId={CONTROL_CLIENT_ID}
              quality={viewQuality}
              retry={streamRetry}
              onError={reconnectStream}
              onReady={streamConnected}
              onTransportError={(error) => setStreamFeedback(`${error?.message || "WebRTC 暂不可用"}，正在重连。`)}
              alt="机器鱼视觉处理画面"
            />
            {streamState !== "ready" && <div className={`video-stream-status ${streamState}`}>
              <strong>{streamState === "error" ? "视频流暂时不可用" : "正在连接视频流…"}</strong>
              <span>{streamState === "error" ? (sessionErrorMessage(status) || "视频连接暂时中断，正在自动重试") : "请稍候，摄像头画面即将出现"}</span>
            </div>}
          </> : <div className={`video-placeholder ${status.state === "error" ? "has-error" : ""}`}><strong>{status.state === "error" ? "摄像头启动失败" : "视觉画面未启动"}</strong><span>{sessionErrorMessage(status) || "选择摄像头后开始预览"}</span></div>}
          {localPreview && browserStream ? <div className="video-badge">电脑摄像头<br />本机 {clock}<br />预览独立于服务器识别</div> : running && previewEnabled && <div className="video-badge">服务器 {serverClock}<br />本机 {clock}{latencyLabel}<br />{videoWidth} × {videoHeight}</div>}
        </div>
        {!showControls ? null : manual ? <aside className="vision-controls manual-video-controls-panel">
          <div className="vision-control-head"><h2>视频设置</h2></div>
          {sharedOverlayPanel}
          {sharedExposurePanel}
          <p className="feedback manual-shared-feedback" aria-live="polite">{streamFeedback || feedback || (running ? `摄像头 ${status.cameraIndex} · ${yoloLabel}` : "视频服务未启动")}</p>
        </aside> : <aside className="vision-controls">
          <div className="vision-control-head"><h2>视觉控制</h2><small>{controlModeLabel}</small></div>
          <section className="vision-mode-panel">
            <div className="mode-grid">{TRACKING_MODES.map(([name, label]) => <button key={name} type="button" className={trackingMode === name ? "active" : ""} aria-pressed={trackingMode === name} disabled={switchingCamera || trackingMode === name} onClick={() => changeTrackingMode(name)}>{label}</button>)}</div>
            <small>当前：{trackingModeLabel}</small>
          </section>
          <section className="vision-mode-panel">
            <div className="mode-grid">
              <button type="button" className="active" aria-pressed="true" disabled>自动控制</button>
            </div>
            <small>根据鱼的实时速度、偏航误差、曲率和距离自动调节推进</small>
          </section>
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
            <button disabled={!running} onClick={() => sendAction({ type: "path.clear" })}>清除轨迹</button>
            <button disabled={!running} onClick={() => sendAction({ type: "recording.toggle" })}>录像</button>
            <button disabled={!running} onClick={() => sendAction({ type: "snapshot.capture" })}>截图</button>
          </div>
          <div className="tracking-actions"><button disabled={!running || !workflow.canStart || targetRequiredForMotion} onClick={() => sendAction({ type: "tracking.start" })}>{targetRequiredForMotion ? "选择鱼后循迹" : workflow.trackingActive ? "循迹运行中" : "启动循迹"}</button><button className="stop" disabled={!running} onClick={() => sendAction({ type: "tracking.stop" })}>停止循迹</button></div>
          <p className="feedback" aria-live="polite">{streamFeedback || feedback || yolo?.error || yolo?.lastInferenceError || (running ? `摄像头 ${status.cameraIndex} 正在处理 · ${yoloLabel} · ${coordinateLabel}` : "视觉服务未启动")}</p>
        </aside>}
      </div>
    </section>
  );
}
