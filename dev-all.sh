#!/usr/bin/env bash
# Boot Kioku, Kokoro, Kizuna, and Kansoku under Turbo's TUI multiplexer.
# Prints the Portless URL table, then hands off to `turbo run dev`.
# Ctrl-C stops everything (Turbo owns the process tree).
#
# Flags:
#   --only <target>...   run only these targets (everything else excluded)
#   --no   <target>...   run everything except these
#   --stream             force streamed [prefix] output instead of TUI
#   -h, --help           show this help
#
# A <target> is either a project ("kioku" / "kokoro" / "kizuna" / "kansoku" / "kao")
# or a single component ("kioku:api", "kokoro:bot", "kansoku:dashboard", ...).
#
# Examples:
#   ./dev-all.sh                             # everything
#   ./dev-all.sh --no kokoro:bot             # everything but the Telegram bot
#   ./dev-all.sh --only kioku kizuna         # both APIs + dashboards, no Kokoro
#   ./dev-all.sh --only kioku:api            # just the Kioku API
#   ./dev-all.sh --no kokoro:dashboard kizuna:dashboard --stream
#
# All four boot in parallel. Kokoro's Kioku client is fail-open: if Kioku
# is slow or down, calls degrade in-place and a 5-min sweeper retries any
# pending writes. The Kansoku log shipper installed by `@kagami/logger`
# is fail-open on every sibling — if Kansoku is unreachable, services
# continue logging to stdout and the shipper buffers + drops oldest.
# Nothing else touches Kioku at startup.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

if [[ ! -f "$ROOT/package.json" ]]; then
  echo "missing: $ROOT/package.json — run from Kagami workspace root" >&2
  exit 1
fi

# Canonical component list (also defines display order in the URL banner).
ALL="kioku:api kioku:dashboard kokoro:bot kokoro:dashboard kizuna:api kizuna:dashboard kansoku:api kansoku:dashboard kao:api kao:dashboard"

pkg_for() {
  case "$1" in
    kioku:api)         echo @kioku/api ;;
    kioku:dashboard)   echo @kioku/dashboard ;;
    kokoro:bot)        echo @kokoro/bot ;;
    kokoro:dashboard)  echo @kokoro/dashboard ;;
    kizuna:api)        echo @kizuna/api ;;
    kizuna:dashboard)  echo @kizuna/dashboard ;;
    kansoku:api)       echo @kansoku/api ;;
    kansoku:dashboard) echo @kansoku/dashboard ;;
    kao:api)           echo @kao/api ;;
    kao:dashboard)     echo @kao/dashboard ;;
    *) return 1 ;;
  esac
}

url_for() {
  case "$1" in
    kioku:api)         echo "https://api.kioku.localhost" ;;
    kioku:dashboard)   echo "https://kioku.localhost" ;;
    kokoro:dashboard)  echo "https://kokoro.localhost" ;;
    kizuna:api)        echo "https://api.kizuna.localhost" ;;
    kizuna:dashboard)  echo "https://kizuna.localhost" ;;
    kansoku:api)       echo "https://api.kansoku.localhost" ;;
    kansoku:dashboard) echo "https://kansoku.localhost" ;;
    kao:api)           echo "https://api.kao.localhost" ;;
    kao:dashboard)     echo "https://kao.localhost" ;;
    *) echo "" ;;
  esac
}

expand() {
  case "$1" in
    kioku)   echo "kioku:api kioku:dashboard" ;;
    kokoro)  echo "kokoro:bot kokoro:dashboard" ;;
    kizuna)  echo "kizuna:api kizuna:dashboard" ;;
    kansoku) echo "kansoku:api kansoku:dashboard" ;;
    kao)     echo "kao:api kao:dashboard" ;;
    *)       echo "$1" ;;
  esac
}

print_help() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
}

only=""
skip=""
force_stream=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      shift
      while [[ $# -gt 0 && "$1" != --* && "$1" != -h ]]; do
        only="$only $1"; shift
      done ;;
    --no)
      shift
      while [[ $# -gt 0 && "$1" != --* && "$1" != -h ]]; do
        skip="$skip $1"; shift
      done ;;
    --stream) force_stream=true; shift ;;
    -h|--help) print_help; exit 0 ;;
    *)
      echo "unknown flag: $1" >&2
      echo "try: $(basename "$0") --help" >&2
      exit 2 ;;
  esac
done

# Build the active component set (space-padded for substring checks).
active=""
if [[ -n "$only" ]]; then
  for t in $only; do
    for c in $(expand "$t"); do
      if ! pkg_for "$c" >/dev/null 2>&1; then
        echo "unknown target: $t" >&2; exit 2
      fi
      [[ " $active " == *" $c "* ]] || active="$active $c"
    done
  done
else
  active="$ALL"
fi
for t in $skip; do
  for c in $(expand "$t"); do
    if ! pkg_for "$c" >/dev/null 2>&1; then
      echo "unknown target: $t" >&2; exit 2
    fi
    active="${active// $c/}"
  done
done
active="$(echo "$active" | xargs)"
[[ -n "$active" ]] || { echo "no targets selected" >&2; exit 2; }

# TUI takes over the terminal, so fall back to streamed output when stdout
# isn't a TTY (CI, piped, redirected).
ui="tui"
if $force_stream || [[ ! -t 1 ]]; then
  ui="stream"
fi

sep="────────────────────────────────────────────────────────"
echo "$sep"
for c in $ALL; do
  [[ " $active " == *" $c "* ]] || continue
  url="$(url_for "$c")"
  [[ -n "$url" ]] || url="(Telegram long-poll, no URL)"
  printf "  %-36s [%s]\n" "$url" "${c/:/ }"
done
echo "$sep"
if [[ "$ui" == "tui" ]]; then
  echo "  TUI: arrows switch panes · m toggles multi-view · Ctrl-C stops all"
  echo "$sep"
fi

# "Pretty in dev" is a property of THIS runner, not of each service's env.
# Turbo multiplexes child stdout (TUI panes / streamed prefixes), so it's
# never an interactive TTY and @kagami/logger's TTY gate would emit raw
# NDJSON. Force human-pretty here once — Turbo forwards this to every dev
# child — instead of repeating LOG_PRETTY in four .env files. Standalone
# runs and production still auto-detect (and an explicit LOG_PRETTY in the
# environment, e.g. `LOG_PRETTY=0 ./dev-all.sh`, still wins via `:-`).
export LOG_PRETTY="${LOG_PRETTY:-1}"

# Build the turbo --filter list and hand off. `exec` replaces this shell so
# Turbo owns the process tree directly — Ctrl-C, child cleanup, and exit
# status all flow through it without the bash-level traps and PID juggling
# the previous version needed.
filters=()
for c in $ALL; do
  [[ " $active " == *" $c "* ]] || continue
  filters+=(--filter="$(pkg_for "$c")")
done

exec npx turbo run dev "${filters[@]}" --ui="$ui" --concurrency=12
