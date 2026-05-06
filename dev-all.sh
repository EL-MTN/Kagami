#!/usr/bin/env bash
# Boot Kioku, Kokoro, and Kizuna together with prefixed output.
# Kokoro depends on Kioku over HTTP, so Kioku starts first.
# Ctrl-C terminates all three.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/package.json" ]]; then
  echo "missing: $ROOT/package.json — run from Kagami workspace root" >&2
  exit 1
fi

pids=()

cleanup() {
  echo
  echo "stopping..."
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

start() {
  local name="$1"
  local filter="$2"
  ( npx turbo run dev --filter="$filter" ) 2>&1 \
    | awk -v p="[$name] " '{print p $0; fflush()}' &
  pids+=($!)
}

start kioku  '@kioku/*'
sleep 2
start kokoro '@kokoro/*'
start kizuna '@kizuna/*'

wait
