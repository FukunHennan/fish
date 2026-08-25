export function visionStreamSource(retry) {
  return `/api/vision/stream.mjpg?retry=${retry}`;
}
