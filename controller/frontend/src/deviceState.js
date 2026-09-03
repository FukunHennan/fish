function pressedOrderValue(turnOrder, code) {
  if (turnOrder instanceof Map) return turnOrder.get(code);
  if (turnOrder && typeof turnOrder === "object") return turnOrder[code];
  return undefined;
}

function turnDirection(code) {
  if (code === "KeyA") return "left";
  if (code === "KeyD") return "right";
  return null;
}

function latestTurnCode(pressed, turnOrder) {
  let latestCode = null;
  let latestOrder = -1;
  for (const code of ["KeyA", "KeyD"]) {
    if (!pressed.has(code)) continue;
    const order = pressedOrderValue(turnOrder, code);
    if (!Number.isFinite(order)) {
      if (latestCode === null) latestCode = code;
      continue;
    }
    if (order >= latestOrder) {
      latestOrder = order;
      latestCode = code;
    }
  }
  return latestCode;
}

export function keyboardMode(pressed, turnOrder = null) {
  if (pressed.has("KeyS") || pressed.has("Space")) return "stop";
  const latestTurn = latestTurnCode(pressed, turnOrder);
  if (latestTurn) return turnDirection(latestTurn);
  if (pressed.has("KeyW")) return "forward";
  return "stop";
}

export function deviceStateSignature(devices) {
  return JSON.stringify(
    devices
      .map(({
        lastSeen,
        uptimeMs,
        lastControlMs,
        batterySampleAgeMs,
        rssi,
        visionActive,
        visionSessionId,
        visionSequence,
        lease,
        ...stable
      }) => ({
        ...stable,
        lease: lease ? {
          deviceId: lease.deviceId,
          ownerId: lease.ownerId,
          ownerName: lease.ownerName,
          ownerEmail: lease.ownerEmail,
          mode: lease.mode,
        } : null,
      })),
  );
}

export function mergeDevicesInStableOrder(previous, incoming) {
  const incomingById = new Map(incoming.map((device) => [device.deviceId, device]));
  const previousIds = previous.map((device) => device.deviceId);
  const retained = previousIds
    .filter((deviceId) => incomingById.has(deviceId))
    .map((deviceId) => incomingById.get(deviceId));
  const newDevices = incoming.filter((device) => !previousIds.includes(device.deviceId));
  return [...retained, ...newDevices];
}
