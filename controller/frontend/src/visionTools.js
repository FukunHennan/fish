const SELECTION_ACTIONS = {
  calibration: "calibration.toggle",
  marker: "marker.select",
  heading: "heading.select",
};

export function transitionVisionTool(currentTool, nextTool) {
  const activeTool = currentTool === nextTool ? "" : nextTool;
  return {
    activeTool,
    actionType: SELECTION_ACTIONS[nextTool] || "",
  };
}
