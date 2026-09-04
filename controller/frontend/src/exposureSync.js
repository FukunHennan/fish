export function createExposureSync() {
  return {
    editing: false, pending: null, seen: new Set(),
    begin() { this.editing = true; },
    submit(id, value) { this.editing = false; this.pending = { id, value }; },
    finish(action) {
      if (!action?.actionId || action.status === undefined || this.seen.has(action.actionId)) return false;
      this.seen.add(action.actionId);
      if (this.seen.size > 100) this.seen.delete(this.seen.values().next().value);
      if (action.actionId !== this.pending?.id) return false;
      this.pending = null;
      return !this.editing;
    },
    fail(id) { if (this.pending?.id !== id) return false; this.pending = null; return true; },
    blocked() { return this.editing || this.pending !== null; },
  };
}
