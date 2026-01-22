#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f ".env" && -f ".env.example" ]]; then
  cp ".env.example" ".env"
  echo "[vidunpack] Created .env from .env.example (edit keys if needed)."
fi

export DATA_DIR="${DATA_DIR:-data}"
export TOOLSERVER_PORT="${TOOLSERVER_PORT:-6791}"
export ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-6785}"

TOOLSERVER=""
for c in "$ROOT/bin/vidunpack-toolserver" "$ROOT/target/release/vidunpack-toolserver" "$ROOT/target/debug/vidunpack-toolserver"; do
  if [[ -f "$c" && -x "$c" ]]; then
    TOOLSERVER="$c"
    break
  fi
done

if [[ -z "$TOOLSERVER" ]]; then
  echo "toolserver binary not found (expected bin/vidunpack-toolserver or target/release/vidunpack-toolserver)" >&2
  exit 1
fi

echo "[vidunpack] Starting toolserver: $TOOLSERVER"
"$TOOLSERVER" &
TOOL_PID=$!

cleanup() {
  if kill -0 "$TOOL_PID" 2>/dev/null; then
    echo "[vidunpack] Stopping toolserver…"
    kill "$TOOL_PID" || true
  fi
}
trap cleanup EXIT

echo "[vidunpack] Starting orchestrator…"
if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "node_modules not found. Run 'npm ci --omit=dev' in the package root first." >&2
  exit 1
fi
cd "$ROOT/apps/orchestrator"
node dist/index.js
