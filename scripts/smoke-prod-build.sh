#!/usr/bin/env bash
# Regression guard for the production build path.
#
# The class of bug this catches: a service that cannot run as plain
# `node dist/...` because something in its graph (notably @kagami/logger
# or @kagami/llm) resolves to raw .ts, or a build that silently emits
# nothing. That failure has no other automated detection — full API
# suites need a MongoDB binary.
#
# Builds the compiled-prod packages, then boots each API's dist entrypoint
# and asserts it gets PAST module resolution. A clean env makes the servers
# fail fast on Mongo/config — that's expected and counts as success here;
# only a .ts / module-resolution error is a failure.
#
# Usage: npm run smoke   (or: bash scripts/smoke-prod-build.sh)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "── building compiled-prod packages ──"
npx turbo run build \
  --filter=@kagami/logger \
  --filter=@kagami/llm \
  --filter=@kioku/api \
  --filter=@kansoku/api \
  --filter=@kizuna/api

fail=0

boot_check() {
  local name="$1" dir="$2" entry="$3"
  local log
  log="$(mktemp)"
  ( cd "$dir" && node "$entry" ) >"$log" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 15 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if grep -qE 'ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension "\.ts"|Cannot find package .@kagami/(logger|llm).|ERR_MODULE_NOT_FOUND' "$log"; then
    echo "FAIL  $name — module/.ts resolution error:"
    tail -n 5 "$log" | sed 's/^/      /'
    fail=1
  else
    echo "OK    $name — boots past module resolution"
  fi
  rm -f "$log"
}

echo
echo "── booting compiled entrypoints under plain node ──"
boot_check "@kioku/api"   kioku/apps/api   dist/server.js
boot_check "@kansoku/api" kansoku/apps/api dist/server.js
boot_check "@kizuna/api"  kizuna/apps/api  dist/main.js

echo
if [ "$fail" -ne 0 ]; then
  echo "SMOKE FAILED — a service cannot run from compiled output."
  exit 1
fi
echo "SMOKE PASSED — all services boot from compiled output."
