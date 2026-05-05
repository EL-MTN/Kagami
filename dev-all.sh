#!/usr/bin/env bash
# Boot Kioku, Kokoro, and Kizuna together with prefixed output.
# Kokoro depends on Kioku over HTTP, so Kioku starts first.
# Ctrl-C terminates all three.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

projects=(Kioku Kokoro Kizuna)

for p in "${projects[@]}"; do
  if [[ ! -d "$ROOT/$p" ]]; then
    echo "missing: $ROOT/$p — move the project in first" >&2
    exit 1
  fi
  if [[ ! -f "$ROOT/$p/package.json" ]]; then
    echo "no package.json in $ROOT/$p" >&2
    exit 1
  fi
done

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
  ( cd "$ROOT/$name" && npm run dev ) 2>&1 \
    | awk -v p="[$name] " '{print p $0; fflush()}' &
  pids+=($!)
}

start Kioku
sleep 2
start Kokoro
start Kizuna

wait
