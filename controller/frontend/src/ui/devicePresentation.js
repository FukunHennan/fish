export const ROLE_LABELS = { Admin: "管理员", User: "普通用户" };

export function deviceLabel(device) {
  return device?.name || device?.deviceId || "未命名机器鱼";
}

export function leaseIsMine(lease, user) {
  if (!lease || !user) return false;
  return Boolean(
    (user.id && lease.ownerId === user.id)
    || (user.email && lease.ownerEmail === user.email),
  );
}

export function leaseSummary(device, user) {
  const lease = device?.lease;
  if (!lease) {
    return { className: "free", label: "空闲", owner: "—", account: "尚未接管", mine: false };
  }
  if (leaseIsMine(lease, user)) {
    return {
      className: "mine",
      label: "我的控制",
      owner: `我 · ${lease.ownerName || user.name || "当前用户"}`,
      account: lease.ownerEmail || user.email || "当前账户",
      mine: true,
    };
  }
  return {
    className: "other",
    label: "他人控制",
    owner: lease.ownerName || "其他用户",
    account: lease.ownerEmail || "账户信息不可用",
    mine: false,
  };
}

export function roleLabel(user) {
  return user?.roleLabel || ROLE_LABELS[user?.role] || "普通用户";
}

export function formatBytes(bytes = 0) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function batteryLevel(device) {
  const value = Number(device?.batteryPercent);
  return Number.isFinite(value) && Number(device?.batteryVoltage) > 0 ? value : null;
}

export function batteryTone(percent) {
  return percent == null ? "unknown" : percent < 20 ? "critical" : percent < 40 ? "low" : "normal";
}
