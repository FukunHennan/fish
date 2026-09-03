#!/usr/bin/env bash
set -euo pipefail

echo "Stopping Fish Controller and child processes..."
RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/../controller/.runtime" && pwd)"

stop_pidfile() {
  local pidfile="$1"
  local label="$2"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1; then
      echo "Stopped $label."
    fi
    rm -f "$pidfile"
  fi
}

stop_pidfile "$RUNTIME/fish-controller.pid" "Fish Controller"
stop_pidfile "$RUNTIME/frpc.pid" "frpc"

if ! pgrep -f "fish-controller$" >/dev/null 2>&1 && ! pgrep -f "frpc( |$)" >/dev/null 2>&1; then
  echo "Stopped."
fi
