export function containedMediaRect(bounds, mediaWidth, mediaHeight) {
  if (!bounds?.width || !bounds?.height || !mediaWidth || !mediaHeight) return bounds;
  const scale = Math.min(bounds.width / mediaWidth, bounds.height / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height,
  };
}

export function toVideoPoint(pointer, bounds, videoWidth, videoHeight, mediaWidth = videoWidth, mediaHeight = videoHeight) {
  const content = containedMediaRect(bounds, mediaWidth, mediaHeight);
  const displayedX = Math.max(0, Math.min(content.width, pointer.clientX - content.left));
  const displayedY = Math.max(0, Math.min(content.height, pointer.clientY - content.top));
  return {
    x: Math.min(videoWidth - 1, Math.round(displayedX * videoWidth / content.width)),
    y: Math.min(videoHeight - 1, Math.round(displayedY * videoHeight / content.height)),
  };
}

export function chooseCameraIndex(current, cameras, status) {
  if (status?.state === "running" && Number.isInteger(status.cameraIndex)) {
    return String(status.cameraIndex);
  }
  if (current !== "" || !cameras.length) return current;
  return String(cameras[0].index);
}
