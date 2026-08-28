export function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function motionCenter(profile, mode) {
  const min = clamp(profile.servoMin, 0, 179, 20);
  const max = clamp(profile.servoMax, min + 1, 180, 160);
  const center = clamp(profile.straightCenter, min, max, 90);

  if (mode === "left") {
    return center + (max - center) * clamp(profile.leftCenterRatio, 0, 1, 0.5);
  }
  if (mode === "right") {
    return center - (center - min) * clamp(profile.rightCenterRatio, 0, 1, 0.5);
  }
  return center;
}

export function motionAmplitude(profile, center, mode) {
  const min = clamp(profile.servoMin, 0, 179, 20);
  const max = clamp(profile.servoMax, min + 1, 180, 160);
  const percent = mode === "left"
    ? profile.leftAmplitudePercent
    : mode === "right"
      ? profile.rightAmplitudePercent
      : profile.forwardAmplitudePercent;

  return Math.min(center - min, max - center) * clamp(percent, 0, 1, 0.4);
}

export function motionRange(profile, mode) {
  const center = motionCenter(profile, mode);
  const amplitude = motionAmplitude(profile, center, mode);
  return {
    center,
    amplitude,
    min: center - amplitude,
    max: center + amplitude,
  };
}

export function formatDeg(value, digits = 1) {
  return `${Number(value).toFixed(digits)}°`;
}
