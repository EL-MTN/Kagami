# Dashboard

Read-only inspector for Kioku's data, built with Next.js 16 + Tailwind CSS v4. Lives at `apps/dashboard/`, served at `https://kioku.localhost` via Portless. Every page is a server component that fetches the API at `KIOKU_API_URL` (default `https://api.kioku.localhost`).

## Page map

| Route        | Purpose                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Overview: total fact count, sessions, categories, 30-day ingest sparkline, monthly stratum, top categories, recent facts. |
| `/facts`     | Facts list. Filter by source_session, scope, date range; paginated.                                                       |
| `/facts/:id` | Per-fact detail with audit history (`/facts/:id/history`).                                                                |
| `/sessions`  | Group facts by `source_session`.                                                                                          |
| `/recall`    | Live recall playground — POST `/recall`, render ranked facts with score-fusion bar.                                       |
| `/query`     | Live query playground — POST `/query`, render answer.                                                                     |
| `/health`    | Hits `/health` and `/version`.                                                                                            |

The sidebar (`apps/dashboard/src/components/sidebar.tsx`) is the canonical link list.

## Library (`apps/dashboard/src/lib/`)

- `api.ts` — typed fetch wrappers around the REST surface. Re-exports `KIOKU_BASE` for direct callers.
- `format.ts` — date / number formatting helpers (`monthKey`, etc.).
- `utils.ts` — `cn` className helper.

`api.ts` sets `cache: "no-store"` on every fetch so server components always hit live data; pages opt in to dynamic rendering via `export const dynamic = "force-dynamic"`.

## Components

| Component               | Purpose                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sidebar.tsx`           | Persistent left rail. Includes `憶` wordmark and live `getVersion()` call.                                                |
| `nav-link.tsx`          | Sidebar link with lucide icon name → component map.                                                                       |
| `fact-card.tsx`         | Compact fact preview with category chip + event date.                                                                     |
| `query-playground.tsx`  | Client component for `/query` — input, Submit, render `{ answer, citations }`.                                            |
| `recall-playground.tsx` | Client component for `/recall` — input, K, filters, render `RankedFact[]` with `score-bar.tsx`.                           |
| `score-bar.tsx`         | Three-channel stacked bar: cosine (indigo), BM25 (moss), entity boost (amber). Hues match the `--color-channel-*` tokens. |
| `sparkline.tsx`         | Inline SVG sparkline for 30-day ingest cadence.                                                                           |
| `stat-card.tsx`         | Headline stat with optional hint and tone (`positive`, `neutral`).                                                        |
| `stratum.tsx`           | Sediment-style stack of monthly fact counts; deeper layers = older.                                                       |
| `shell/`                | `PageHeader`, `EmptyState`.                                                                                               |
| `ui/`                   | shadcn-shaped primitives (only what the app uses — no boilerplate dump).                                                  |

## Design system — "Kioku Daylight" (白)

A warm-paper light theme inherited from Kokoro Daylight, with the secondary accent tilted toward moss to suggest accumulation — memory growing like sediment. The palette lives in `apps/dashboard/src/app/globals.css` under Tailwind v4's `@theme inline` block. The `憶` wordmark in the sidebar is the canonical brand mark.

### Typography

- **Display**: Instrument Serif — page titles and the kanji wordmark only
- **Body**: DM Sans — set as `--font-sans`
- **Monospace**: JetBrains Mono — set as `--font-mono`. **Stat values, fact counts, timestamps, and scores use mono tabular numerals** — the project default for any scannable number.

All three are loaded via `next/font/google` with CSS variable injection in `layout.tsx`.

### Color palette (OKLch)

- **Background**: warm vellum (`oklch(0.985 0.006 85)`)
- **Card surfaces**: paper raised (`oklch(0.998 0.004 85)`)
- **Foreground**: sumi ink (`oklch(0.22 0.015 60)`)
- **Borders**: warm rule (`oklch(0.91 0.008 75)`); strong rule for emphasis (`oklch(0.84 0.010 75)`)
- **Primary**: indigo (`oklch(0.52 0.13 245)`) — links, active states, primary actions
- **Positive**: moss (`oklch(0.58 0.13 155)`) — ingest cadence, healthy state
- **Caution**: amber (`oklch(0.68 0.14 75)`) — entity-channel hue, partial degradation
- **Critical**: terracotta (`oklch(0.55 0.18 25)`) — errors, failed query

### Channel hues (score-fusion bar)

Three retrieval signals share the score-fusion bar. Distinct hues but matched chroma so they read as a family:

| Channel    | Hue    | Token                      |
| ---------- | ------ | -------------------------- |
| `semantic` | indigo | `--color-channel-semantic` |
| `bm25`     | moss   | `--color-channel-bm25`     |
| `entity`   | amber  | `--color-channel-entity`   |

### Text-level contract

Three text levels only — no opacity ladder. Components must use one of:

| Token                   | Use                                                      |
| ----------------------- | -------------------------------------------------------- |
| `text-foreground`       | Primary content                                          |
| `text-muted-foreground` | Secondary content (descriptions, captions)               |
| `text-faint`            | Tertiary metadata (timestamps, counts, "30 days" labels) |

Avoid `text-muted-foreground/30..70` etc. The `/N` modifier antipattern was swept out in the Daylight switch and is regression-prone.

### Visual details

- `body::before` gradient wash — amber top-right, moss bottom-left, very low alpha. Kioku's wash tilts toward moss to differ from Kokoro's indigo cool.
- Custom scrollbar (warm rule, 8 px)
- Staggered fade-in on card grids (`.stagger`)
- Shimmer skeletons (`.skeleton`)
- `.kicker` utility for small-caps section headers (`text-[10px] uppercase tracking-[0.18em] text-muted-foreground`) — preferred over re-stating the classes per-section

## API surface used

The dashboard hits the same REST endpoints documented in [api.md](api.md):

- `GET /health`, `GET /version`
- `GET /facts`, `GET /facts/count`, `GET /facts/:id`, `GET /facts/:id/history`
- `POST /recall`, `POST /query`

The dashboard does not write — there's no `POST /facts` or `POST /sessions` UI today.

## Configuration

| Env var         | Default                       | Purpose                                      |
| --------------- | ----------------------------- | -------------------------------------------- |
| `KIOKU_API_URL` | `https://api.kioku.localhost` | Base URL for `apps/dashboard/src/lib/api.ts` |

The dashboard binds to whatever port Portless injects (`PORT`) when run via `portless run next dev`. Standalone fallback is the Next default (`3000`).
