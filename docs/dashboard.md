# Dashboard

Web dashboard for managing and inspecting Mashiro's data, built with Next.js 15 + Tailwind CSS v4 + shadcn/ui (Radix primitives).

## Design System

The dashboard uses a **"Noir Atelier"** design language — a refined dark workspace with warm amber accents.

### Typography

- **Display**: Instrument Serif (Google Fonts) — used for page titles and large numbers via `font-display` Tailwind utility
- **Body**: DM Sans (Google Fonts) — set as `--font-sans` in Tailwind theme
- **Monospace**: JetBrains Mono (Google Fonts) — set as `--font-mono` in Tailwind theme

All three fonts are loaded via `next/font/google` with CSS variable injection in `layout.tsx`.

### Color Palette (OKLch)

- **Background**: Deep warm charcoal (`oklch(0.085 0.005 60)`)
- **Card surfaces**: Slightly elevated (`oklch(0.115 0.005 60)`)
- **Primary accent**: Warm amber/gold (`oklch(0.78 0.12 75)`) — used for active states, links, glows
- **Destructive**: Warm red (`oklch(0.42 0.16 25)`)
- **Borders**: Subtle warm gray (`oklch(0.185 0.005 60)`)

All colors are defined as CSS custom properties in `globals.css` via Tailwind v4's `@theme inline` block.

### Visual Details

- Subtle ambient radial gradient glow (warm amber) at viewport top
- Custom scrollbar styling (thin, warm gray)
- Staggered fade-in animations on card grids (`.stagger` CSS class)
- Shimmer loading skeletons (`.skeleton` CSS class)
- Status indicators use small colored dots instead of badges
- Importance ratings shown as bar visualizations
- Activity feed uses timeline-style layout with vertical connector line
- Sidebar active state: amber left-border glow with box-shadow
- Dialog overlay: backdrop blur + semi-transparent black

## Environment

Create `apps/dashboard/.env.local`:

```
MONGODB_URI=mongodb://localhost:27017/mashiro
DASHBOARD_PASSWORD=your-password-here  # optional — HTTP Basic Auth gate
```

No LLM/embedding API keys needed — the config refactor (see below) ensures the dashboard can import `@mashiro/db` and `@mashiro/shared` without triggering validation for those keys.

When `DASHBOARD_PASSWORD` is set, the `middleware.ts` middleware enforces HTTP Basic Auth on all routes. The browser handles the native login dialog. If unset, all routes are open (dev convenience).

## Running

```bash
npm run dev          # starts both bot and dashboard via turbo
# or
cd apps/dashboard && npm run dev   # dashboard only (port 3000)
```

## Pages

| Route                   | Description                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/`                     | Overview — stat cards (conversations, memories, facts, reminders), emotional trend chart, recent activity feed |
| `/conversations`        | Paginated table of all conversation sessions with status, message count, platform, dates                       |
| `/conversations/[id]`   | Conversation detail — header metadata + scrollable message history with chat bubbles                           |
| `/memories`             | Tabbed view by type (fact/episode/milestone/working) with count badges, paginated                              |
| `/reminders`            | Reminder table with message, fire time, status (pending/fired), toggle to show fired                           |
| `/skills`               | Skill management — table with enable/disable, create, import, export                                           |
| `/skills/[id]`          | Skill detail — inline editor (prompt, params, cron, report mode) + execution log history                       |
| `/api/skills`           | GET list, POST create, POST `?action=import` bulk import                                                       |
| `/api/skills/export`    | GET — download all skills as versioned JSON bundle                                                             |
| `/api/skills/[id]`      | GET detail, PATCH update, DELETE                                                                               |
| `/api/skills/[id]/logs` | GET paginated execution logs (cursor-based via `?before=`)                                                     |
| `/api/skills/[id]/run`  | POST — sets `manualRunRequestedAt` so the bot's scheduler picks the skill up on its next 3 s tick              |
| `/api/images/[key]`     | GridFS image proxy — serves stored images by key with immutable cache headers                                  |

## Architecture

### Data Flow

```
MongoDB ← ensureDB() ← query functions ← server components (pages)
```

Read-only pages are React Server Components. Skill management uses a hybrid model: pages are server components for initial render, with interactive client components (`SkillTable`, `SkillEditor`, dialogs) for mutation. Client components call `/api/skills/*` route handlers via `fetch()`.

### DB Connection

`src/lib/db.ts` — Mongoose singleton cached on `globalThis` to survive Next.js HMR. Every server component calls `await ensureDB()` before querying.

### Query Layer

All in `src/lib/queries/`:

- `overview.ts` — `getOverviewStats()`, `getEmotionalTrend()`, `getRecentActivity()`
- `conversations.ts` — `getConversationList(page)`, `getConversationDetail(id)`
- `memories.ts` — `getMemoriesByType(type, page)`, `getMemoryTypeCounts()`
- `reminders.ts` — `getReminderList(showFired?)`
- `skills.ts` — `getSkillList()`, `getSkillDetail(id)`, `getSkillLogList(skillId, limit, before?)`

Queries use `@mashiro/db` models directly. `@mashiro/memory` is **not** imported (it depends on Google AI SDK which is unnecessary for read-only display).

### Validation

`src/lib/skill-schema.ts` — Zod schemas shared between API route handlers (server-side validation) and client components (live validation). Exports: `skillCreateSchema`, `skillPatchSchema`, `skillExportBundleSchema`, and inferred TypeScript types. Zero Node.js-specific imports so it works in both runtimes.

Cron validation (parse + required-defaults check) lives in `@mashiro/shared` (`validateCronAndDefaults`, `computeNextRunAt`) so the bot's `manageSkills` tool and the dashboard API routes share one implementation.

### Editor UX

`SkillEditor` (`src/components/skills/skill-editor.tsx`) supports Cmd/Ctrl+S to save, a `beforeunload` guard while dirty, and an inline Run button (disabled while dirty) that drives the run-now flow described above. Cron preview helpers live in `src/lib/cron-format.ts` (`describeCron`, `cronLabel`).

### Export/Import Format

Skills are exported as a versioned JSON bundle:

```json
{
  "version": 1,
  "exportedAt": "2026-03-16T12:00:00.000Z",
  "count": 3,
  "skills": [
    { "name": "...", "description": "...", "prompt": "...", "parameters": [...], ... }
  ]
}
```

Runtime fields (`_id`, `chatId`, `nextRunAt`, `version`, timestamps) are stripped on export and regenerated on import. Duplicate names are skipped, not rejected.

### Config Refactor

`@mashiro/shared/config.ts` was split into:

- **Base parse** (always succeeds) — validates structure + defaults, no API key requirements
- **`validateConfig()`** — strict check for LLM/embedding keys, called explicitly by the bot at startup

This allows the dashboard to import `@mashiro/db` → `@mashiro/shared` without `process.exit(1)` from missing API keys.

### Next.js Config

- `transpilePackages` for `@mashiro/*` workspace packages
- `serverExternalPackages` for `mongoose`, `pino`, `pino-pretty` (Node.js native modules)

## Components

| Component                        | Type   | Purpose                                                                                                                                   |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `sidebar.tsx`                    | Server | Nav sidebar with page links                                                                                                               |
| `nav-link.tsx`                   | Client | Active route highlighting via `usePathname()`                                                                                             |
| `stat-card.tsx`                  | Server | Reusable stats card (icon, label, value)                                                                                                  |
| `emotional-indicator.tsx`        | Server | Trend badge (rising/falling/stable)                                                                                                       |
| `activity-feed.tsx`              | Server | Recent conversations + memories interleaved by time                                                                                       |
| `message-bubble.tsx`             | Server | Chat message with role-based styling, tool call display                                                                                   |
| `memory-card.tsx`                | Server | Memory content with importance/type badges                                                                                                |
| `pagination.tsx`                 | Server | Simple prev/next page links                                                                                                               |
| `skills/skill-table.tsx`         | Client | Interactive skill list with name/description search, enabled/cron filters, enable/disable toggle (with rollback toast on failure), delete |
| `skills/skill-editor.tsx`        | Client | Inline skill editing with live cron preview, dirty tracking, Cmd+S save, navigate-away guard                                              |
| `skills/skill-run-button.tsx`    | Client | Triggers a manual run via `/api/skills/[id]/run` and polls logs for the result                                                            |
| `skills/skill-create-dialog.tsx` | Client | New skill creation dialog (chatId picked from a select of known chats with a "+ New chat…" escape hatch)                                  |
| `skills/skill-import-dialog.tsx` | Client | Drag-drop/paste JSON import with preview                                                                                                  |
| `skills/skill-delete-dialog.tsx` | Client | Confirm delete dialog                                                                                                                     |
| `skills/skill-log-table.tsx`     | Client | Execution logs with expandable summaries, load more                                                                                       |
| `skills/parameter-editor.tsx`    | Client | Dynamic parameter list editor with type-aware defaults                                                                                    |

## Dependencies

Dashboard-specific (beyond monorepo shared):

- `tailwindcss` v4 + `@tailwindcss/postcss` — CSS framework
- `class-variance-authority`, `clsx`, `tailwind-merge` — shadcn/ui utilities
- `lucide-react` — icons
- `radix-ui` — shadcn/ui primitives (card, badge, table, tabs, scroll-area, separator, dialog, switch)
- `zod` — request/response validation (shared between API routes and client components)
- `cron-parser` — computing `nextRunAt` from cron expressions on skill create/update
- `cronstrue` — human-readable cron descriptions
- `next/font/google` — Instrument Serif, DM Sans, JetBrains Mono fonts (no extra npm packages)
