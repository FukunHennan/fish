export const DEFAULT_KEYS = { forward: "KeyW", left: "KeyA", right: "KeyD", stop: "KeyS" };
export function mappedMode(pressed, keys) {
  if (pressed.has("Space") || pressed.has(keys.stop)) return "stop";
  const turns = ["left", "right"].filter(mode => pressed.has(keys[mode]));
  if (turns.length) return turns.sort((a,b) => pressed.get(keys[b]) - pressed.get(keys[a]))[0];
  return pressed.has(keys.forward) ? "forward" : "stop";
}
// Each device has its own ordered promise chain. Releasing one key cannot
// supersede another device's command. No implicit acquisition on keydown.
export function createMultiKeyboard({ targets, send, onError = () => {} }) {
  const pressed = new Map(), states = new Map();
  let order = 0;
  function dispatch(device, mode) {
    const id = device.deviceId;
    const state = states.get(id) || { mode: "stop", promise: Promise.resolve() };
    if (state.mode === mode) return;
    state.mode = mode;
    state.device = device;
    state.promise = state.promise.catch(() => {}).then(() => send(device, mode)).catch(error => {
      // A transport failure may hide an accepted motion; attempt neutral once.
      if (mode !== "stop") { state.mode = "stop"; return send(device, "stop").catch(() => {}).finally(() => onError(error)); }
      onError(error);
    });
    states.set(id, state);
  }
  function update() {
    const current = targets();
    for (const [id, state] of states) if (!current.some(t => t.device.deviceId === id)) dispatch(state.device, "stop");
    for (const { device, keys } of current) if (!states.get(device.deviceId)?.suspended) dispatch(device, mappedMode(pressed, keys));
  }
  return {
    key(code, down) {
      const relevant = code === "Space" || targets().some(t => Object.values(t.keys).includes(code));
      if (!relevant && !pressed.has(code)) return false;
      if (down) {
        if (!pressed.has(code)) {
          pressed.set(code, ++order);
          for (const target of targets()) if (Object.values(target.keys).includes(code)) {
            const state = states.get(target.device.deviceId); if (state) state.suspended = false;
          }
        }
      } else pressed.delete(code);
      update(); return true;
    },
    stop(device) {
      if (!device) pressed.clear();
      for (const state of states.values()) if (!device || device.deviceId === state.device.deviceId) { state.suspended = true; dispatch(state.device, "stop"); }
      return Promise.all([...states.values()].map(s => s.promise));
    },
    mode(deviceId) { return states.get(deviceId)?.mode || "stop"; },
    active() { return [...states.values()].filter(s => s.mode !== "stop").map(s => s.device); },
    update,
  };
}
