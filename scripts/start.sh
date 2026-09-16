#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROLLER="$ROOT/controller"
FRONTEND="$CONTROLLER/frontend"
RUNTIME="$CONTROLLER/.runtime"
EXE="$RUNTIME/fish-controller"
CONTROLLER_LOG="$RUNTIME/fish-controller.log"
CONTROLLER_PID="$RUNTIME/fish-controller.pid"

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

if [[ -f "$CONTROLLER_PID" ]]; then
  OLD_PID="$(cat "$CONTROLLER_PID" 2>/dev/null || true)"
  if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    echo "[INFO] Fish Controller already running (pid=$OLD_PID)."
  else
    rm -f "$CONTROLLER_PID"
  fi
fi

if [[ ! -f "$CONTROLLER_PID" ]]; then
  echo "[4/4] Starting Fish Controller..."
  "$EXE" >>"$CONTROLLER_LOG" 2>&1 &
  echo $! > "$CONTROLLER_PID"
fi

echo
echo "Started. Open: http://localhost:8081"
