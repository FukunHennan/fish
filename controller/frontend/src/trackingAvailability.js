export function trackingStartBlockers({
  running,
  workflow = {},
  effectiveTargetDeviceId = "",
  singleFishMode = false,
  detectionCount = 0,
  selectedTrackId = null,
  targetFound = false,
  processing = false,
}) {
  if (!running) return ["视觉服务未启动"];

  const blockers = Array.isArray(workflow.blockers)
    ? workflow.blockers.filter((reason) => typeof reason === "string" && reason.trim())
    : [];

  if (!effectiveTargetDeviceId) {
    blockers.unshift("请先选择要控制的机器鱼");
  } else if (!singleFishMode && Number(detectionCount) > 1 && selectedTrackId === null) {
    blockers.unshift("检测到多条鱼，请锁定单一目标");
  } else if (!singleFishMode && selectedTrackId !== null && !targetFound && processing) {
    blockers.unshift(`目标 #${selectedTrackId} 暂未识别`);
  }

  if (workflow.trackingActive === true) {
    blockers.unshift("循迹已经在运行");
  }
  if (workflow.canStart !== true && blockers.length === 0) {
    blockers.push("当前条件尚未满足");
  }
  return [...new Set(blockers)];
}
