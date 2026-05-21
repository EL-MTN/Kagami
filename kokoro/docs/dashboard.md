# Dashboard

Web dashboard for managing and inspecting Kokoro's data, built with Next.js 15 + Tailwind CSS v4 + shadcn/ui (Radix primitives).

## Design System

The dashboard uses **"Kokoro Daylight" (心)** — a warm-paper light theme tuned for observability rather than mood. The earlier "Noir Atelier" dark palette was retired because it traded legibility for atmosphere, which is the wrong tradeoff for a surface whose job is scanning numbers and statuses. The palette lives in `apps/dashboard/src/app/globals.css` (`@theme inline` block) and the wordmark 心 in the sidebar is the canonical brand mark.

### Typography

- **Display**: Instrument Serif (Google Fonts) — page titles and the kanji wordmark only
- **Body**: DM Sans (Google Fonts) — set as `--font-sans`
- **Monospace**: JetBrains Mono (Google Fonts) — set as `--font-mono`. **Stat values, costs, tone scores, and timestamps use mono tabular numerals** — this is the single biggest legibility win and is the project default for any scannable number.

All three fonts are loaded via `next/font/google` with CSS variable injection in `layout.tsx`.

### Color Palette (OKLch)

- **Background**: warm vellum (`oklch(0.985 0.006 85)`)
- **Card surfaces**: paper raised (`oklch(0.998 0.004 85)`)
- **Foreground**: sumi ink (`oklch(0.22 0.015 60)`)
- **Borders**: warm rule (`oklch(0.91 0.008 75)`); strong rule for emphasis (`oklch(0.84 0.010 75)`)
- **Primary**: indigo (`oklch(0.52 0.13 245)`) — links, active states, primary actions
- **Positive**: moss (`oklch(0.58 0.13 155)`) — rising tone, successful run
- **Caution**: amber (`oklch(0.68 0.14 75)`) — pending approvals, share-of-total ≥40%, cooldown-suppressed watcher fires
- **Critical**: terracotta (`oklch(0.55 0.18 25)`) — error, triggered watcher fires, share-of-total ≥70%

All colors live in `globals.css` under Tailwind v4's `@theme inline` block.

### Text-level contract

Three text levels only — no opacity ladder. Components must use one of:

| Token                   | Use                                                           |
| ----------------------- | ------------------------------------------------------------- |
| `text-foreground`       | Primary content                                               |
| `text-muted-foreground` | Secondary content (descriptions, captions, secondary cells)   |
| `text-faint`            | Tertiary metadata (timestamps, counts, "30 days" annotations) |

Avoid `text-muted-foreground/30..70` etc. The `/N` modifier antipattern was swept out in the Kokoro Daylight switch and is regression-prone.

### Visual Details

- `body::before` gradient wash — peach top-right, indigo bottom-left, very low alpha — adds atmosphere without noise
- Custom scrollbar (warm rule, 8px)
- Staggered fade-in animations on card grids (`.stagger` CSS class)
- Shimmer loading skeletons (`.skeleton` CSS class)
- `.kicker` utility for small-caps section headers (`text-[10px] uppercase tracking-[0.18em] text-muted-foreground`) — preferred over re-stating the classes per-section
- Inline SVG sparklines (`components/sparkline.tsx`) for emotional trend (`/`) and daily cost trend (`/usage`)
- Watcher state markers shape-coded: filled disc = triggered, hollow ring = silenced, hairline tick = observation
- Activity feed: typed icons by event source, relative timestamps as primary label, full datetime in `title` attribute

## Environment

Create `apps/dashboard/.env.local`:

```
MONGODB_URI=mongodb://localhost:27017/kokoro
DASHBOARD_PASSWORD=your-password-here  # optional — HTTP Basic Auth gate
```

No LLM/embedding API keys needed — the config refactor (see below) ensures the dashboard can import `@kokoro/db` and `@kokoro/shared` without triggering validation for those keys.

When `DASHBOARD_PASSWORD` is set, the `middleware.ts` middleware enforces HTTP Basic Auth on all routes. The browser handles the native login dialog. If unset, all routes are open (dev convenience).

## Running

The dashboard runs under [Portless](https://github.com/vercel-labs/portless) (declared in `apps/dashboard/package.json` as `"portless": "kokoro"`, with `dev` set to `portless run next dev`). It serves at `https://kokoro.localhost` with HTTPS auto-trusted and the underlying Next.js port assigned dynamically. First run prompts once for sudo to install the local CA.

```bash
npm run dev          # starts both bot and dashboard via turbo
# or
cd apps/dashboard && npm run dev   # dashboard only (Portless-served at https://kokoro.localhost)
```

## Pages

| Route                     | Description                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                       | Overview — pending-intent surface (preview of awaiting confirmations), stat cards, emotional trend chart, recent activity feed        |
| `/conversations`          | Paginated table with status filter (all/active/closed) and chat-ID search; columns: session, chat, status, messages, platform, dates  |
| `/conversations/[id]`     | Conversation detail — header metadata + scrollable message history with chat bubbles                                                  |
| `/confirmations`          | Pending and recently-resolved approval-gated tool calls with origin (conversation/routine/watcher), tool name, args, expiry countdown |
| `/reminders`              | Reminder table with pending/fired/all pill filter (with counts), message, fire time, status, chat ID, created                         |
| `/routines`               | Routine management — table with enable/disable, create, import, export                                                                |
| `/routines/[id]`          | Routine detail — inline editor (prompt, params, cron, report mode) + execution log history                                            |
| `/watchers`               | Watcher management — table with enable/disable, search, status filter, create, import, export                                         |
| `/watchers/[id]`          | Watcher detail — editor + state-change timeline (de-duplicated observations, shape-coded markers) + execution log history             |
| `/usage`                  | Cost overview, cost-by-routine / cost-by-watcher / cost-by-category breakdowns (30d), daily trend sparkline                           |
| `/api/routines`           | GET list, POST create, POST `?action=import` bulk import                                                                              |
| `/api/routines/export`    | GET — download all routines as versioned JSON bundle                                                                                  |
| `/api/routines/[id]`      | GET detail, PATCH update, DELETE                                                                                                      |
| `/api/routines/[id]/logs` | GET paginated execution logs (cursor-based via `?before=`)                                                                            |
| `/api/routines/[id]/run`  | POST — sets `manualRunRequestedAt` so the bot's scheduler picks the routine up on its next 3 s tick                                   |
| `/api/watchers`           | GET list, POST create, POST `?action=import` bulk import                                                                              |
| `/api/watchers/export`    | GET — download all watchers as versioned JSON bundle                                                                                  |
| `/api/watchers/[id]`      | GET detail, PATCH update, DELETE                                                                                                      |
| `/api/watchers/[id]/logs` | GET paginated execution logs (cursor-based via `?before=`)                                                                            |
| `/api/watchers/[id]/run`  | POST — sets `manualRunRequestedAt` so the bot's 3 s manual-run poll claims and executes with `silent: true`                           |
| `/api/images/[key]`       | GridFS image proxy — serves stored images by key with immutable cache headers                                                         |

## Architecture

### Data Flow

```
MongoDB ← ensureDB() ← query functions ← server components (pages)
```

Read-only pages are React Server Components. Routine management uses a hybrid model: pages are server components for initial render, with interactive client components (`RoutineTable`, `RoutineEditor`, dialogs) for mutation. Client components call `/api/routines/*` route handlers via `fetch()`.

### DB Connection

`src/lib/db.ts` — Mongoose singleton cached on `globalThis` to survive Next.js HMR. Every server component calls `await ensureDB()` before querying.

### Query Layer

All in `src/lib/queries/`:

- `overview.ts` — `getOverviewStats()`, `getEmotionalTrend()`, `getRecentActivity()`
- `conversations.ts` — `getConversationList(page, options?)` with `status` and `search` (chatId regex) filters; `getConversationDetail(id)`
- `confirmations.ts` — `getPendingConfirmationList()`, `getRecentResolvedConfirmations(limit)`, `getPendingConfirmationCount()`
- `reminders.ts` — `getReminderList(showFired?)`
- `routines.ts` — `getRoutineList()`, `getRoutineDetail(id)`, `getRoutineLogList(routineId, limit, before?)`
- `watchers.ts` — `getWatcherList()`, `getWatcherDetail(id)`, `getWatcherLogList(...)`, `getWatcherStateHistory(watcherId, limit)` (collapses consecutive identical states into a transition timeline)
- `usage.ts` — `getUsageOverview()`, `getUsageByCategory(days)`, `getUsageByRoutine(days)`, `getUsageByWatcher(days)` (joins on `metadata.routineId` / `metadata.watcherId`), `getDailyUsageTrend(days)`

Queries use `@kokoro/db` models directly. `@kokoro/memory` is **not** imported (it depends on Google AI SDK which is unnecessary for read-only display).

### Validation

`src/lib/routine-schema.ts` — Zod schemas shared between API route handlers (server-side validation) and client components (live validation). Exports: `routineCreateSchema`, `routinePatchSchema`, `routineExportBundleSchema`, and inferred TypeScript types. Zero Node.js-specific imports so it works in both runtimes.

Cron validation (parse + required-defaults check) lives in `@kokoro/shared` (`validateCronAndDefaults`, `computeNextRunAt`) so the bot's `manageRoutines` tool and the dashboard API routes share one implementation.

### Editor UX

`RoutineEditor` (`src/components/routines/routine-editor.tsx`) supports Cmd/Ctrl+S to save, a `beforeunload` guard while dirty, and an inline Run button (disabled while dirty) that drives the run-now flow described above. Cron preview helpers live in `src/lib/cron-format.ts` (`describeCron`, `cronLabel`).

### Export/Import Format

Routines are exported as a versioned JSON bundle:

```json
{
  "version": 1,
  "exportedAt": "2026-03-16T12:00:00.000Z",
  "count": 3,
  "routines": [
    { "name": "...", "description": "...", "prompt": "...", "parameters": [...], ... }
  ]
}
```

Runtime fields (`_id`, `chatId`, `nextRunAt`, `version`, timestamps) are stripped on export and regenerated on import. Duplicate names are skipped, not rejected.

### Config Refactor

`@kokoro/shared/config.ts` was split into:

- **Base parse** (always succeeds) — validates structure + defaults, no API key requirements
- **`validateConfig()`** — strict check for LLM/embedding keys, called explicitly by the bot at startup

This allows the dashboard to import `@kokoro/db` → `@kokoro/shared` without `process.exit(1)` from missing API keys.

### Next.js Config

- `transpilePackages` for `@kokoro/*` workspace packages
- `serverExternalPackages` for `mongoose`, `pino`, `pino-pretty` (Node.js native modules)

## Components

| Component                            | Type           | Purpose                                                                                                                                     |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidebar.tsx`                        | Server (async) | Nav sidebar with page links; fetches pending confirmation count and renders it as a badge on the Confirmations link                         |
| `nav-link.tsx`                       | Client         | Active route highlighting via `usePathname()`; supports optional numeric `badge` prop                                                       |
| `confirmation-card.tsx`              | Server         | Pending or resolved confirmation row — origin icon, summary, tool name, expandable args/result, expiry countdown or status pill             |
| `watchers/state-timeline.tsx`        | Server         | Vertical timeline of distinct watcher state observations (collapsed against `prevState`) with triggered/silenced/observation tones          |
| `stat-card.tsx`                      | Server         | Reusable stats card (icon, label, value)                                                                                                    |
| `activity-feed.tsx`                  | Server         | Recent conversations + memories interleaved by time                                                                                         |
| `message-bubble.tsx`                 | Server         | Chat message with role-based styling, tool call display                                                                                     |
| `pagination.tsx`                     | Server         | Simple prev/next page links                                                                                                                 |
| `routines/routine-table.tsx`         | Client         | Interactive routine list with name/description search, enabled/cron filters, enable/disable toggle (with rollback toast on failure), delete |
| `routines/routine-editor.tsx`        | Client         | Inline routine editing with live cron preview, dirty tracking, Cmd+S save, navigate-away guard                                              |
| `routines/routine-run-button.tsx`    | Client         | Triggers a manual run via `/api/routines/[id]/run` and polls logs for the result                                                            |
| `routines/routine-create-dialog.tsx` | Client         | New routine creation dialog (chatId picked from a select of known chats with a "+ New chat…" escape hatch)                                  |
| `routines/routine-import-dialog.tsx` | Client         | Drag-drop/paste JSON import with preview                                                                                                    |
| `routines/routine-delete-dialog.tsx` | Client         | Confirm delete dialog                                                                                                                       |
| `routines/routine-log-table.tsx`     | Client         | Execution logs with expandable summaries, load more                                                                                         |
| `routines/parameter-editor.tsx`      | Client         | Dynamic parameter list editor with type-aware defaults                                                                                      |
| `sparkline.tsx`                      | Server         | Inline SVG sparkline (line + faint area + last-point dot, optional baseline). Used by Overview emotional trend and Usage daily-cost trend   |
| `watchers/watcher-table.tsx`         | Client         | Interactive watcher list — search, status filter (all/enabled/snoozed), enable/disable toggle, delete, create                               |
| `watchers/watcher-editor.tsx`        | Client         | Inline watcher editing — prompt, cron, lifecycle controls (oneShot, maxFires, cooldownMinutes), snooze dropdown, dirty tracking             |
| `watchers/watcher-run-button.tsx`    | Client         | Triggers a manual watcher run via `/api/watchers/[id]/run` and polls logs for the result                                                    |
| `watchers/watcher-create-dialog.tsx` | Client         | New watcher creation dialog                                                                                                                 |
| `watchers/watcher-import-dialog.tsx` | Client         | Drag-drop/paste JSON import with preview                                                                                                    |
| `watchers/watcher-delete-dialog.tsx` | Client         | Confirm delete dialog                                                                                                                       |
| `watchers/watcher-log-table.tsx`     | Client         | Execution logs with expandable summaries, load more                                                                                         |
| `watchers/snooze-button.tsx`         | Client         | Inline snooze dropdown for the watcher detail surface                                                                                       |

### Shell Primitives

`src/components/shell/` — composable building blocks every list/table page consumes so the visual language stays consistent. Import via `@/components/shell`.

| Primitive         | Type   | Purpose                                                                                                                                                                                                          |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`      | Server | Title + description + optional right-meta slot. Replaces the per-page `<h2><p>` block.                                                                                                                           |
| `DataToolbar`     | Server | Flex row with `actions` (left) and `filters` (right) slots. Used above tables/grids.                                                                                                                             |
| `FilterPills`     | Client | Controlled segmented pill bar (`value` + `onChange`) for client-state pages like `/routines` and `/watchers`.                                                                                                    |
| `LinkFilterPills` | Server | Link-driven segmented pill bar — each option carries a resolved `href`. Used by URL-state pages. Separate from `FilterPills` because Next.js cannot serialize a function prop across the server/client boundary. |
| `SearchInput`     | Client | Search box with icon. Two modes: controlled (`value`/`onChange`) or URL-synced (`param` — debounced replace).                                                                                                    |
| `DataTable`       | Server | Wraps the shadcn `Table` in the standard rounded/border container, builds the header from a column array, renders an empty state when `rowCount === 0`.                                                          |
| `DataRow`         | Server | Standard `<tr>` styling (border + hover) so callers don't restate it.                                                                                                                                            |
| `EmptyState`      | Server | Empty-state messaging in dashed-border card or inline form.                                                                                                                                                      |

`/conversations`, `/reminders`, `/confirmations` use `LinkFilterPills` + URL-synced `SearchInput` so filter state is shareable and survives reload. `/routines` and `/watchers` use the controlled `FilterPills` + controlled `SearchInput` because their interactive state (toggle, delete, create) lives in client-side React state.

## Dependencies

Dashboard-specific (beyond monorepo shared):

- `tailwindcss` v4 + `@tailwindcss/postcss` — CSS framework
- `class-variance-authority`, `clsx`, `tailwind-merge` — shadcn/ui utilities
- `lucide-react` — icons
- `radix-ui` — shadcn/ui primitives (card, badge, table, tabs, scroll-area, separator, dialog, switch)
- `zod` — request/response validation (shared between API routes and client components)
- `cron-parser` — computing `nextRunAt` from cron expressions on routine create/update
- `cronstrue` — human-readable cron descriptions
- `next/font/google` — Instrument Serif, DM Sans, JetBrains Mono fonts (no extra npm packages)
