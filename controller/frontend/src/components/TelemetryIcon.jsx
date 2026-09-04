export default function TelemetryIcon({ kind, value }) {
  const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false, className: "telemetry-icon" };
  if (kind === "battery") return <svg {...props}>
    <rect x="2" y="6" width="17" height="12" rx="3" /><path d="M22 10v4" />
    {value != null && value > 0 && <rect x="4.5" y="8.5" width={12 * Math.min(100, Math.max(0, value)) / 100} height="7" rx="1" fill="currentColor" stroke="none" />}
    {value == null && <path d="M8 12h5" opacity=".45" />}
  </svg>;
  if (kind === "signal") {
    // Visual bands are indicative; the exact RSSI remains visible alongside.
    const level = value == null ? 0 : value >= -55 ? 4 : value >= -67 ? 3 : value >= -80 ? 2 : 1;
    return <svg {...props}>{[5, 9, 13, 17].map((height, i) => <rect key={height} x={3 + i * 5} y={21 - height} width="2.5" height={height} rx="1.25" fill="currentColor" stroke="none" opacity={i < level ? 1 : .18} />)}</svg>;
  }
  const mode = String(value);
  if (["2", "forward"].includes(mode)) return <svg {...props}><path d="M12 20V4m-6 6 6-6 6 6" /></svg>;
  if (["3", "left"].includes(mode)) return <svg {...props}><path d="M20 19v-6a5 5 0 0 0-5-5H4m5-5L4 8l5 5" /></svg>;
  if (["4", "right"].includes(mode)) return <svg {...props}><path d="M4 19v-6a5 5 0 0 1 5-5h11m-5-5 5 5-5 5" /></svg>;
  if (["0", "stop"].includes(mode)) return <svg {...props}><rect x="6" y="6" width="12" height="12" rx="3" /></svg>;
  if (["1", "idle"].includes(mode)) return <svg {...props}><path d="M8 6v12m8-12v12" /></svg>;
  return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M9 12h6" /></svg>;
}
