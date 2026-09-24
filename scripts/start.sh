#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROLLER="$ROOT/controller"
FRONTEND="$CONTROLLER/frontend"
RUNTIME="$CONTROLLER/.runtime"
EXE="$RUNTIME/fish-controller"

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

echo "[4/4] Starting Fish Controller in this terminal..."
echo "Close this terminal to stop the controller and its attached services."
echo "Open: http://localhost:8081"
exec "$EXE"
