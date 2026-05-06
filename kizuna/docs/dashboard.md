# Dashboard

Read-only inspector for Kizuna's CRM data, plus the OAuth grant and ingest control surfaces. Built with Next.js 15 (App Router) + Tailwind CSS v4 + shadcn-shaped primitives. Lives at `apps/dashboard/`, served at `https://kizuna.localhost` via Portless. Every page is a server component that fetches the API at `KIZUNA_API_URL` (default `https://api.kizuna.localhost`) using `Authorization: Bearer ${KIZUNA_API_KEY}`.

## Page map

```
apps/dashboard/src/app/
├── layout.tsx                       # root html, font CSS variables
├── globals.css                      # design tokens (Mashiro Daylight)
├── (auth)/
│   └── login/page.tsx               # API-key sign-in form
└── (app)/                           # auth-gated route group; layout.tsx checks the cookie
    ├── layout.tsx                   # sidebar + main content; redirects to /login on miss
    ├── page.tsx                     # /             — Today
    ├── ui.tsx                       # Card, Badge, ChannelBadge, ErrorBlock, PersonLink, Mono, …
    ├── people/
    │   ├── page.tsx                 # /people       — list + filter form
    │   └── [id]/page.tsx            # /people/:id   — detail + per-person interactions + followups
    ├── contexts/page.tsx            # /contexts     — distinct tags + tag-scoped detail
    ├── sync/page.tsx                # /sync         — OAuth status + Gmail/Calendar ingest control
    ├── errors/page.tsx              # /errors       — placeholder; ingest error log is a roadmap item
    └── tombstones/page.tsx          # /tombstones   — soft-deleted People / Interactions / Followups
```

The sidebar (`src/components/sidebar.tsx`) is the canonical link list:

```
絆 Kizuna · Personal CRM
   Today
   People
   Contexts
   Sync
   Errors
   Tombstones
   Sign out
```

`Sign out` is a `<form action={logoutAction}>` so it works without JS (the action lives in `src/lib/auth-actions.ts`).

## Data flow

Every page is a **server component** with `export const dynamic = 'force-dynamic'`. There is no client-side data fetching, no SWR, no React Query — every render hits the API fresh. Mutations are server actions:

- `src/app/(app)/sync/page.tsx` → `runGmailSyncAction`, `runGcalSyncAction` (POST `/v1/sync/.../run` then `revalidatePath('/sync')`).
- `src/app/(auth)/login/page.tsx` → `loginAction` (compares the submitted key, sets the session cookie, redirects).
- `src/app/(app)/layout.tsx` → `logoutAction` mounted on the sidebar's "Sign out" button.

There are no POST/PATCH/DELETE for People / Interactions / Followups in the dashboard — the API has them, but the dashboard is intentionally read-only. The roadmap is to keep mutation in the concierge agent and use the dashboard for inspection only.

## Library (`apps/dashboard/src/lib/`)

```
src/lib/
├── api.ts             # Typed fetch wrapper around the REST surface
├── types.ts           # Hand-mirrored response shapes (keep in sync with apps/api/src/lib/serialize.ts)
├── session.ts         # makeSessionToken, verifySessionToken, checkApiKey (HMAC + 30-day TTL)
├── auth-actions.ts    # loginAction, logoutAction (server actions)
├── format.ts          # fmtDateTime, fmtDate, fmtRelative, fmtBytes  (America/New_York)
└── utils.ts           # cn(...) — clsx + tailwind-merge
```

### `api.ts`

Sets `cache: 'no-store'` on every fetch so server components always hit live data. Throws `ApiError(status, message)` on non-2xx. Helpers cover every endpoint the dashboard uses today:

```ts
api.listPeople(q)
api.getPerson(id)
api.getPersonInteractions(id, q)
api.listInteractions(q)
api.listFollowups(q)
api.listOrganizations(q)
api.getOrganization(id)
api.listContexts(q)
api.oauthStatus()
api.gmailSyncState()
api.runGmailSync(force?)
api.gcalSyncState()
api.runGcalSync(force?)
```

`oauthStartUrl()` returns `${KIZUNA_API_URL}/oauth/google/start?key=${KIZUNA_API_KEY}` so the "Connect Google" button is a plain `<a href>`.

The exported `config` object also reads `process.env.USER_EMAILS` at module scope so per-person pages can mark interactions as "outbound" (sender's primaryEmail ∈ USER_EMAILS) vs "inbound."

### `session.ts`

The dashboard's auth model: HMAC-signed cookies, secret = `KIZUNA_API_KEY`, 30-day TTL. See [auth.md](auth.md). The session cookie name is `kizuna_session`. `verifySessionToken` is called from `src/app/(app)/layout.tsx` and short-circuits to `redirect('/login')` if absent or invalid.

### `types.ts`

Hand-mirrored from `apps/api/src/lib/serialize.ts`. The header comment says "Mirrors the API response shapes ... Keep in sync with that file when shapes change." A future refactor could emit these from the manifest's JSON Schema.

## Components

```
src/components/
├── sidebar.tsx                      # left rail with kanji wordmark + nav + sign-out
├── nav-link.tsx                     # active-state link with lucide icon
├── shell/
│   ├── page-header.tsx              # h2 title + optional description + meta slot
│   ├── data-table.tsx               # DataTable + DataRow over @/components/ui/table
│   ├── empty-state.tsx
│   └── index.ts
└── ui/                              # shadcn-shaped primitives (only what the app uses)
    ├── badge.tsx                    # cva-driven variants (default, positive, caution, critical, muted, outline, secondary)
    ├── button.tsx                   # cva variants (default, destructive, outline, secondary, ghost, link) + sizes
    ├── card.tsx
    └── table.tsx
```

`src/app/(app)/ui.tsx` re-exports the primitives plus app-specific compositions:

- `Card`, `CardHeader`, `Empty`
- `Badge`, `ChannelBadge`, `StatusBadge`, `DirectionBadge` — domain-specific tone-mapped wrappers around `<Badge variant=...>`
- `PersonLink` — underlined link to `/people/:id`
- `Mono` — `<code>` chip for IDs / cursors / scopes
- `ErrorBlock` — terracotta panel with `<pre>` detail block
- `PageHeader` re-export

shadcn config is in `components.json`: style `new-york`, base color `zinc`, lucide icons, alias `@/components`. Tailwind config lives in `src/app/globals.css` as `@theme inline` per Tailwind v4. There's no `tailwind.config.js`.

## Design system — "Mashiro Daylight (白) — Kizuna edition"

Inherited from Kokoro Daylight, palette tilted to teal-blue. Lives entirely in `apps/dashboard/src/app/globals.css` under Tailwind v4's `@theme inline` block. The `絆` wordmark in the sidebar is the canonical brand mark.

### Typography

- **Display**: Instrument Serif — page titles and the kanji wordmark only
- **Body**: DM Sans — set as `--font-sans`
- **Monospace**: JetBrains Mono — set as `--font-mono`. Stat values, IDs, timestamps, cursors, and scopes use mono tabular numerals (`tabular-nums`)

All three load via `next/font/google` with CSS variable injection in `src/app/layout.tsx`.

### Color palette (OKLch)

| Token                      | Value                   | Use                                               |
| -------------------------- | ----------------------- | ------------------------------------------------- |
| `--color-background`       | `oklch(0.985 0.006 85)` | Vellum                                            |
| `--color-card`             | `oklch(0.998 0.004 85)` | Paper raised                                      |
| `--color-foreground`       | `oklch(0.22 0.015 60)`  | Sumi ink                                          |
| `--color-muted-foreground` | `oklch(0.45 0.012 60)`  | Secondary text                                    |
| `--color-faint`            | `oklch(0.62 0.010 60)`  | Tertiary metadata (timestamps, counts)            |
| `--color-border`           | `oklch(0.91 0.008 75)`  | Warm rule                                         |
| `--color-rule-strong`      | `oklch(0.84 0.010 75)`  | Stronger separator                                |
| `--color-primary`          | `oklch(0.48 0.085 205)` | Teal ink — links, primary action                  |
| `--color-positive`         | `oklch(0.58 0.13 155)`  | Moss — success, "in_person" / "call" badges       |
| `--color-caution`          | `oklch(0.68 0.14 75)`   | Amber — warn, "calendar" badge, `i_owe` direction |
| `--color-critical`         | `oklch(0.55 0.18 25)`   | Terracotta — error, tombstone marker              |

### Text-level contract

Three text levels — no opacity ladder. Components must use one of:

| Token                   | Use                                        |
| ----------------------- | ------------------------------------------ |
| `text-foreground`       | Primary content                            |
| `text-muted-foreground` | Secondary content (descriptions, captions) |
| `text-faint`            | Tertiary metadata (timestamps, counts)     |

Avoid `text-muted-foreground/30..70` etc.

### Visual details

- `body::before` gradient wash — amber top-right, teal bottom-left, very low alpha
- Custom scrollbar (`oklch(0.84 0.010 75)`, 8 px)
- Staggered fade-in on card grids (`.stagger`)
- Shimmer skeletons (`.skeleton`)
- `.kicker` utility for small-caps section headers (`text-[10px] uppercase tracking-[0.18em] text-muted-foreground`) — preferred over re-stating the classes per-section

### Channel badge mapping (`src/app/(app)/ui.tsx::ChannelBadge`)

| Channel     | Tone  |
| ----------- | ----- |
| `email`     | blue  |
| `calendar`  | amber |
| `in_person` | green |
| `call`      | green |
| `message`   | zinc  |
| `manual`    | zinc  |

Followup direction (`DirectionBadge`):

| Direction  | Tone  | Label      |
| ---------- | ----- | ---------- |
| `i_owe`    | amber | "I owe"    |
| `they_owe` | blue  | "they owe" |

## API surface used

The dashboard hits the same REST endpoints documented in [api.md](api.md):

- `GET /v1/people`, `/v1/people/:id`, `/v1/people/:id/interactions`
- `GET /v1/interactions`, `/v1/followups`, `/v1/organizations`, `/v1/contexts`
- `GET /oauth/google/status`
- `GET /v1/sync/{gmail,gcal}/state`
- `POST /v1/sync/{gmail,gcal}/run` (force optional)

The dashboard does not write CRM data — there's no `POST /v1/people` UI today.

## Configuration

`apps/dashboard/.env`:

```
KIZUNA_API_URL=https://api.kizuna.localhost
KIZUNA_API_KEY=<same key as the API>
USER_EMAILS=you@example.com
```

`KIZUNA_COOKIE_SECURE=true` forces the session cookie to `Secure` even in non-production (Portless serves HTTPS in dev, so this is the default behavior under `NODE_ENV !== 'production'` only when explicitly enabled).

The dashboard binds to whatever port Portless injects (`PORT`) when run via `portless run next dev`. Standalone fallback is the Next default. See [configuration.md](configuration.md).
