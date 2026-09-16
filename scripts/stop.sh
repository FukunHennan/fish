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
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      for _ in {1..20}; do
        kill -0 "$pid" >/dev/null 2>&1 || break
        sleep 0.1
      done
      if kill -0 "$pid" >/dev/null 2>&1; then
        kill -KILL "$pid" >/dev/null 2>&1 || true
      fi
      echo "Stopped $label (pid=$pid)."
    fi
    rm -f "$pidfile"
  fi
}

stop_pidfile "$RUNTIME/fish-controller.pid" "Fish Controller"

echo "Stopped."
