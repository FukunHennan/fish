#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROLLER="$ROOT/controller"
FRONTEND="$CONTROLLER/frontend"
RUNTIME="$CONTROLLER/.runtime"
AUTH_DATA="$ROOT/../Pro1-runtime"
EXE="$RUNTIME/fish-controller"

if [[ ! -f "$CONTROLLER/go.mod" ]]; then
  echo "[ERROR] controller/go.mod not found."
  exit 1
fi

command -v go >/dev/null || { echo "[ERROR] Go was not found in PATH."; exit 1; }
command -v npm >/dev/null || { echo "[ERROR] npm was not found in PATH."; exit 1; }

for config in firmware.json program.json tunnel.json; do
  if [[ ! -f "$ROOT/config/$config" ]]; then
    echo "[ERROR] config/$config is missing."
    exit 1
  fi
done

if [[ ! -d "$FRONTEND/node_modules" ]]; then
  echo "[1/4] Installing frontend dependencies..."
  (cd "$FRONTEND" && npm install)
fi

echo "[2/4] Building frontend..."
(cd "$FRONTEND" && npm run build)

mkdir -p "$RUNTIME"
mkdir -p "$AUTH_DATA"
if [[ -z "${FISH_AUTH_USERS:-}" && ! -f "$AUTH_DATA/users.json" ]]; then
  legacy_dir="$RUNTIME"
  if [[ ! -f "$legacy_dir/users.json" ]]; then legacy_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish-controller"; fi
  if [[ -f "$legacy_dir/users.json" ]]; then
    echo "[INFO] Migrating the existing account store..."
    for name in users.json.sessions.json users.json.reservations.json users.json; do
      if [[ -f "$legacy_dir/$name" ]]; then cp "$legacy_dir/$name" "$AUTH_DATA/$name"; fi
    done
  fi
fi

echo "[3/4] Building Go controller..."
(cd "$CONTROLLER" && go build -o "$EXE" ./cmd/fish-controller)

echo "[4/4] Starting Fish Controller in this terminal..."
echo "Close this terminal to stop the controller and its attached services."
echo "Open: http://localhost:8081"
exec "$EXE"
