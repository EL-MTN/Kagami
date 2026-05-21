---
name: kansoku-debug
description: Debug runtime behavior of Kagami services (Kioku, Kokoro, Kizuna, Kansoku, Kao) using the Kansoku observability service. Use whenever investigating a failure, unexpected behavior, error stack trace, slow response, or "what happened" question — especially when given a trace ID (32 hex chars), an error fingerprint (16 hex chars), a service name, or a time window. Trigger phrases include "why did X fail", "debug Y", "what happened around T", "trace Z", "check the logs", "find the error", "this is broken", or any reference to a service emitting structured logs.
---

# kansoku-debug — observability-driven debugging in the Kagami workspace

You are debugging a Kagami service. The workspace ships a CLI that reads logs, traces, errors, and per-service metrics from **Kansoku** (the observability service every sibling pushes to). Use it before greping source, guessing, or asking the user for more context — the answer is usually already in the ingested logs.

## When this skill applies

- The user reports a bug, regression, or "weird behavior" in any Kagami service.
- The user supplies a trace ID, error message, stack trace, or a rough time ("around 3pm").
- You see an error in another tool's output that includes a `traceId` field.
- You want to confirm whether a recent code change actually shows up at runtime.

## When this skill does NOT apply

- The user is asking about static code structure — read the source, don't query logs.
- The behavior in question is purely build-time (typecheck/lint/test failures).
- Kansoku itself is the subject of the change — fall back to the project's own tests and docs.

## Prerequisites

The CLI talks to `https://api.kansoku.localhost`, which only exists when the Kansoku API is running. If you get a network failure or a 404 page from Portless:

```bash
npm run kansoku:dev:api   # boots the API under Portless
```

Override the base URL via `--url <baseUrl>` or the `KANSOKU_URL` env var if you need to target somewhere else.

## The CLI

All commands run from the Kagami workspace root. Pass `--` before flags so npm doesn't eat them.

```bash
# Fetch one trace by its 32-hex-char ID. Shows waterfall + log timeline.
# Error fields (type, message, stack) appear inline in the timeline,
# truncated at 240 chars per log line.
npm run kansoku:debug -- trace <traceId>

# Search logs. Any subset of filters; --since/--until are ISO timestamps.
# --service: exact match on the stored service name. Valid values:
#            kokoro-bot | kioku-api | kizuna-api | kansoku-api | kao-api.
# --level:   trace | debug | info | warn | error | fatal
npm run kansoku:debug -- logs --service kokoro-bot --level error --limit 100
npm run kansoku:debug -- logs --since 2026-05-20T14:00:00Z --until 2026-05-20T15:00:00Z

# Fingerprinted error registry. Server stores up to 20 recent trace IDs per
# fingerprint; the pretty-printed output shows the last 5 — use --json to
# see all of them.
npm run kansoku:debug -- errors --service kioku-api

# Per-service summary: counts of logs / errors / warns in a window.
npm run kansoku:debug -- services --window 6   # last 6 hours

# Any subcommand accepts --json for the raw API payload.
npm run kansoku:debug -- trace <id> --json | jq '.spans'
```

## Workflows

### "Something is broken, I don't have a trace ID"

1. `npm run kansoku:debug -- errors --service <suspected service>` — newest fingerprints first.
2. Pick the fingerprint that matches the user's report by message/stack.
3. Copy one of the `recent traces` IDs and run `npm run kansoku:debug -- trace <id>`.
4. Read the waterfall + log timeline to reconstruct the request path.

### "It happened around <time>"

1. `npm run kansoku:debug -- logs --service <svc> --since <ISO> --until <ISO> --limit 200`.
2. The footer lists every unique trace ID in the result set — pivot into the most suspicious one with `trace <id>`.

### "Here's a stack trace from <somewhere>"

1. If the stack came from a structured Kagami log, it carried a `traceId` — grep it for 32 hex chars and jump straight to `trace <id>`.
2. If only the error message is available, `errors` will fingerprint similar past occurrences; the fingerprint groups normalize over heap addresses / IDs.

### "Did my fix actually take?"

1. Trigger the behavior the fix targets.
2. `npm run kansoku:debug -- logs --service <svc> --limit 50` and confirm the new code path's log lines appear (or the old error doesn't).

## Interpreting the output

- **Waterfall**: each bar's offset = wall-clock start within the trace, width = duration. `=` is healthy, `!` means the span ended in error. The "real" tag means spans came from `runWithSpan` lifecycle events; "log-derived" means durations were approximated from log min/max timestamps.
- **Service names** follow `<workspace>-<component>`: `kokoro-bot`, `kioku-api`, `kizuna-api`, `kansoku-api`, `kao-api`. The `--service` filter is exact-match (no prefix), so a bare `kokoro` returns nothing.
- **Trace ID format**: 32 hex chars, case-insensitive (server normalizes to lowercase). The CLI rejects malformed IDs locally with `trace: invalid trace id (must be 32 hex chars): <id>` on stderr; the API would return `{error: "invalid_trace_id"}` if the regex were ever bypassed.
- **Retention**: time-series TTL defaults to 30 days. Older traces are gone — Mongo expired them. If `trace <id>` returns "no records found", retention is the likely cause.
- **Fingerprints**: 16 hex chars. The errors registry deduplicates by fingerprint, so `count > 1` means recurrence.

## Failure modes

- **404 from Portless** (HTML body): API isn't running. `npm run kansoku:dev:api`.
- **`Network failure ... ECONNREFUSED`**: API process died. Restart it.
- **`trace: invalid trace id (must be 32 hex chars)`**: the ID isn't 32 hex chars. Check whether you copied a span ID (16 chars) or a fingerprint (16 chars) by mistake.
- **Empty trace result on a known-real ID**: TTL evicted it. Tell the user the trace is past retention.

## Output discipline

After running these commands, summarize what you found for the user — don't dump raw output. Quote the specific log line, span, or error message that answers the question, with the trace ID so they can verify in the dashboard at `https://kansoku.localhost/traces/<id>`.
