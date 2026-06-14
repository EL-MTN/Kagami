# Kansoku — Dashboard

Next.js 16 inspector at `https://kansoku.localhost`. Server-rendered pages
where possible (overview, search, traces, errors, services); a single
client-side island for the SSE live tail. Reads from `KANSOKU_API_URL`
(default `https://api.kansoku.localhost`).

## Pages

| Path           | Type   | Backed by                                                                                                                 |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `/`            | server | `GET /health`, `GET /version` — overview cards + feature links                                                            |
| `/tail`        | client | SSE `GET /v1/tail` — service picker + level chips, pause/clear                                                            |
| `/search`      | server | `GET /v1/logs?service&level&since&until&limit` — service picker + multi-level chips; defaults to last 15m when unfiltered |
| `/traces`      | server | `GET /v1/traces` — recent-traces browser (root msg, counts, duration, error flag)                                         |
| `/traces/[id]` | server | `GET /v1/traces/:id` — waterfall (two-line labels, `op` headline, time axis) + flat log timeline                          |
| `/errors`      | server | `GET /v1/errors?service&limit&sort&since` — fingerprinted groups; sort + time-window controls                             |
| `/services`    | server | `GET /v1/services` + `GET /v1/services/:service/timeline` — cards                                                         |

## Design

Mashiro Daylight palette ([globals.css](../apps/dashboard/src/app/globals.css)).
Instrument Serif (display) + DM Sans + JetBrains Mono. shadcn-shaped components live under
`src/components/`; per-page composition lives under `src/app/<route>/`. Shared
filter primitives: `ServiceSelect` (a dual-mode `<select>` — uncontrolled in
server GET forms via `name`/`defaultValue`, controlled in the client live tail
via `value`/`onChange`) and `LevelChips` (controlled multi-select for live tail)
plus `levelChipFormClassName()` (CSS `has-[:checked]` styling so the Search
page's native-checkbox chips match the live-tail chips).

## Live-tail wire format

`GET /v1/tail?service=&level=&replay=` opens an SSE stream. Each `data:`
line is a `StoredLog` JSON object. Query params:

- `service` — exact match on `meta.service`. Optional.
- `level` — comma-separated list, e.g. `warn,error,fatal`. Empty means
  "muted" on the client; the dashboard refuses to open the stream when no
  levels are checked.
- `replay` — number of recent matching events to replay from the
  in-process ring buffer on connect (0–200, default 50).

A keep-alive comment (`: heartbeat <ts>\n\n`) every 30 s prevents idle
proxies from collapsing the connection. The subscriber cap is 64 — the
65th tab opening `/v1/tail` gets a 503 instead of silently leaking
listener refs.

## Log rows

`src/components/log-row.tsx` (`LogRow`) renders one log line and is shared
by `/tail`, `/search`, and the flat timeline on `/traces/[id]`. It is a
**client component** (it owns expand/collapse state):

- The collapsed row is one line (timestamp, level, service, message,
  trace link). When the log has a non-empty `fields` object a chevron +
  `+N fields` affordance appears, alongside a faint one-line **preview**
  of the most useful field (prefers `responsePreview`/`query`/`text`/…,
  else the first non-`pid`/`hostname` scalar, truncated).
- The trace-link cell is a full-height click target with a hover
  underline + tooltip, so pivoting from a log line to its trace waterfall
  is a single obvious click.
- Expanding renders `fields` as a pretty-printed block. String values
  keep their **real newlines** (a recursive renderer quotes but does not
  `\n`-escape them), so stack traces and multi-line `responsePreview`
  read as actual lines instead of one `"...\n..."` blob. Infra noise
  (`pid`, `hostname`) is rendered last in a faint style so meaningful
  fields read first.
- `showSpanId` prop: on `/traces/[id]` the per-row trace link is
  redundant, so the trace page passes `showSpanId` to render the span id
  in that column instead.

## Caching

Per-service timeline fetches on `/services` use an in-memory 30 s TTL
cache (`apps/dashboard/src/lib/api.ts`) so a fresh render doesn't fan
out N aggregations. The cache is bounded at 64 entries.

## Conventions

- **Server components** for everything except the live tail.
- **Suspense** is not currently used — the data shape is small enough
  that synchronous `await` from each page is fine.
- **CORS** to the API is granted only for the four `*.localhost` Kagami
  origins (`apps/api/src/lib/cors.ts`).
- **`KANSOKU_API_URL`** must be reachable from both the Next.js server
  _and_ the user's browser (the live tail's `EventSource` runs
  browser-side). The default Portless host satisfies both; only override
  when your topology makes one URL work for both sides.

## Accessibility

- Sidebar nav uses `<aside>` + `<nav>`; the window switcher on
  `/services` uses `<nav aria-label="Window">` with `aria-current="page"`.
- Live-tail level toggles carry `aria-pressed`; Pause / Clear buttons
  carry `aria-label`.
- The Search page's level chips are native checkboxes (so the GET form
  submits multi-level natively); their active state and focus ring are
  CSS-driven (`has-[:checked]` / `has-[:focus-visible]`) for instant
  feedback without a round-trip.
- All status colors have non-color affordances (text, badge shape).
