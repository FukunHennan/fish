#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROLLER="$ROOT/controller"
FRONTEND="$CONTROLLER/frontend"
RUNTIME="$CONTROLLER/.runtime"
EXE="$RUNTIME/fish-controller"
FRPC_CONFIG="$ROOT/config/frpc.toml"
FRPC_LOG="$RUNTIME/frpc.log"
CONTROLLER_PID="$RUNTIME/fish-controller.pid"
FRPC_PID="$RUNTIME/frpc.pid"

if [[ ! -f "$CONTROLLER/go.mod" ]]; then
  echo "[ERROR] controller/go.mod not found."
  exit 1
fi

command -v go >/dev/null || { echo "[ERROR] Go was not found in PATH."; exit 1; }
command -v npm >/dev/null || { echo "[ERROR] npm was not found in PATH."; exit 1; }

if [[ ! -f "$ROOT/config/deployment.json" ]]; then
  if [[ ! -f "$ROOT/config/deployment.example.json" ]]; then
    echo "[ERROR] config/deployment.example.json is missing."
    exit 1
  fi
  cp "$ROOT/config/deployment.example.json" "$ROOT/config/deployment.json"
fi

if [[ ! -d "$FRONTEND/node_modules" ]]; then
  echo "[1/4] Installing frontend dependencies..."
  (cd "$FRONTEND" && npm install)
fi

echo "[2/4] Building frontend..."
(cd "$FRONTEND" && npm run build)

mkdir -p "$RUNTIME"

echo "[3/4] Building Go controller..."
(cd "$CONTROLLER" && go build -o "$EXE" ./cmd/fish-controller)

if pgrep -f "fish-controller$" >/dev/null 2>&1; then
  echo "[INFO] An existing Fish Controller is running. Stopping it first..."
  pkill -f "fish-controller$" || true
  sleep 1
fi

echo "[4/4] Starting Fish Controller..."
"$EXE" >/dev/null 2>&1 &
echo $! > "$CONTROLLER_PID"

if [[ -f "$FRPC_CONFIG" ]]; then
  FRPC_BIN="${FISH_FRPC:-}"
  if [[ -z "$FRPC_BIN" ]]; then
    if command -v frpc >/dev/null 2>&1; then
      FRPC_BIN="$(command -v frpc)"
    fi
  fi
  if [[ -n "$FRPC_BIN" ]]; then
    echo "[INFO] Starting frpc using $FRPC_CONFIG..."
    "$FRPC_BIN" -c "$FRPC_CONFIG" >"$FRPC_LOG" 2>&1 &
    echo $! > "$FRPC_PID"
  else
    echo "[INFO] frpc was not found in PATH; skipping public tunnel."
  fi
fi

echo
echo "Started. Open: http://localhost:8081"
