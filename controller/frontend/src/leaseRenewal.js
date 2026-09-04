// Renew only an existing lease; never acquire control or replay motion here.
export function startLeaseRenewal({ getTarget, renew, onError, schedule = setInterval, cancel = clearInterval }) {
  let disposed = false;
  let pending = false;
  const timer = schedule(async () => {
    const target = getTarget();
    if (disposed || pending || !target) return;
    pending = true;
    try {
      await renew(target);
    } catch (error) {
      if (!disposed && getTarget()?.deviceId === target.deviceId) onError(error, target);
    } finally {
      pending = false;
    }
  }, 15000);
  return () => { disposed = true; cancel(timer); };
}
