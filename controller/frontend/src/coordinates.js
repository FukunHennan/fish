export function toVideoPoint(pointer, bounds, videoWidth, videoHeight) {
  const displayedX = Math.max(0, Math.min(bounds.width, pointer.clientX - bounds.left));
  const displayedY = Math.max(0, Math.min(bounds.height, pointer.clientY - bounds.top));
  return {
    x: Math.min(videoWidth - 1, Math.round(displayedX * videoWidth / bounds.width)),
    y: Math.min(videoHeight - 1, Math.round(displayedY * videoHeight / bounds.height)),
  };
}

export function chooseCameraIndex(current, cameras, status) {
  if (status?.state === "running" && Number.isInteger(status.cameraIndex)) {
    return String(status.cameraIndex);
  }
  if (current !== "" || !cameras.length) return current;
  return String(cameras[0].index);
}
