export function fitVideoRect(container, source) {
  const scale = Math.min(container.width / source.width, container.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

export function toSourcePoint(pointer, content, source) {
  const x = Math.round((pointer.x - content.left) * source.width / content.width);
  const y = Math.round((pointer.y - content.top) * source.height / content.height);
  return {
    x: Math.max(0, Math.min(source.width - 1, x)),
    y: Math.max(0, Math.min(source.height - 1, y)),
  };
}
