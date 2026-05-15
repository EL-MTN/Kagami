# Kansoku — Dashboard

Next.js 16 inspector at `https://kansoku.localhost`. Server-rendered pages
where possible (overview, search, traces, errors, services); a single
client-side island for the SSE live tail. Reads from `KANSOKU_API_URL`
(default `https://api.kansoku.localhost`).

## Pages

| Path           | Type   | Backed by                                                           |
| -------------- | ------ | ------------------------------------------------------------------- |
| `/`            | server | `GET /health`, `GET /version` — overview cards + feature links      |
| `/tail`        | client | SSE `GET /v1/tail` — per-service/level filters, pause/clear         |
| `/search`      | server | `GET /v1/logs?service&level&since&until&limit` — newest-first table |
| `/traces/[id]` | server | `GET /v1/traces/:id` — waterfall + flat log timeline                |
| `/errors`      | server | `GET /v1/errors?service&limit` — fingerprinted groups               |
| `/services`    | server | `GET /v1/services` + `GET /v1/services/:service/timeline` — cards   |

## Design

Cool-slate palette ([globals.css](../apps/dashboard/src/app/globals.css)).
DM Sans + JetBrains Mono. shadcn-shaped components live under
`src/components/`; per-page composition lives under `src/app/<route>/`.

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
- All status colors have non-color affordances (text, badge shape).
