export const DEFAULT_KEYS = { forward: "KeyW", left: "KeyA", right: "KeyD", stop: "KeyS", frequencyUp: "KeyQ", frequencyDown: "KeyE", combinedBiasUp: "KeyR", combinedBiasDown: "KeyF" };
export const COMBINED_STEERING_BIAS = 20;
export function mappedCommand(pressed, keys) {
  if (pressed.has("Space") || pressed.has(keys.stop)) return { mode: "stop" };
  const turns = ["left", "right"].filter(mode => pressed.has(keys[mode]));
  const forward = pressed.has(keys.forward);
  const combinedBias = Math.max(0, Math.min(45, Number(keys.combinedBias ?? COMBINED_STEERING_BIAS)));
  if (forward && turns.length === 1) return { mode: "forward", bias: turns[0] === "left" ? -combinedBias : combinedBias };
  if (turns.length) return { mode: turns.sort((a,b) => pressed.get(keys[b]) - pressed.get(keys[a]))[0] };
  return { mode: forward ? "forward" : "stop" };
}
export function mappedMode(pressed, keys) {
  return mappedCommand(pressed, keys).mode;
}
// Each device has its own ordered promise chain. Releasing one key cannot
// supersede another device's command. No implicit acquisition on keydown.
export function createMultiKeyboard({ targets, send, adjust = () => {}, onError = () => {} }) {
  const pressed = new Map(), states = new Map();
  let order = 0;
  function dispatch(device, command) {
    const id = device.deviceId;
    const state = states.get(id) || { mode: "stop", commandKey: "stop:", promise: Promise.resolve() };
    const mode = command.mode;
    const commandKey = `${mode}:${command.bias ?? ""}`;
    if (state.commandKey === commandKey) return;
    state.mode = mode;
    state.commandKey = commandKey;
    state.device = device;
    const override = command.bias === undefined ? undefined : { bias: command.bias };
    state.promise = state.promise.catch(() => {}).then(() => send(device, mode, undefined, override)).catch(error => {
      // A transport failure may hide an accepted motion; attempt neutral once.
      if (mode !== "stop") { state.mode = "stop"; return send(device, "stop").catch(() => {}).finally(() => onError(error)); }
      onError(error);
    });
    states.set(id, state);
  }
  function update() {
    const current = targets();
    for (const [id, state] of states) if (!current.some(t => t.device.deviceId === id)) dispatch(state.device, { mode: "stop" });
    for (const { device, keys } of current) if (!states.get(device.deviceId)?.suspended) dispatch(device, mappedCommand(pressed, keys));
  }
  return {
    key(code, down) {
      const relevant = code === "Space" || targets().some(t => Object.values(t.keys).includes(code));
      if (!relevant && !pressed.has(code)) return false;
      if (down) {
        if (!pressed.has(code)) {
          pressed.set(code, ++order);
          for (const target of targets()) if (target.keys.frequencyUp === code || target.keys.frequencyDown === code || target.keys.combinedBiasUp === code || target.keys.combinedBiasDown === code) {
            if (target.keys.frequencyUp === code || target.keys.frequencyDown === code) {
              adjust(target.device, "frequency", target.keys.frequencyUp === code ? 0.1 : -0.1);
            } else {
              adjust(target.device, "combinedBias", target.keys.combinedBiasUp === code ? 1 : -1);
            }
          }
          for (const target of targets()) if (["forward", "left", "right", "stop"].some(mode => target.keys[mode] === code)) {
            const state = states.get(target.device.deviceId); if (state) state.suspended = false;
          }
        }
      } else pressed.delete(code);
      update(); return true;
    },
    stop(device) {
      if (!device) pressed.clear();
      for (const state of states.values()) if (!device || device.deviceId === state.device.deviceId) { state.suspended = true; dispatch(state.device, { mode: "stop" }); }
      return Promise.all([...states.values()].map(s => s.promise));
    },
    mode(deviceId) { return states.get(deviceId)?.mode || "stop"; },
    active() { return [...states.values()].filter(s => s.mode !== "stop").map(s => s.device); },
    update,
  };
}
