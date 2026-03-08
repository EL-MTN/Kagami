# Dashboard

Read-only web dashboard for inspecting Mashiro's data, built with Next.js 15 + Tailwind CSS v4 + shadcn/ui.

## Environment

The dashboard only requires `MONGODB_URI`. Create `apps/dashboard/.env.local`:

```
MONGODB_URI=mongodb://localhost:27017/mashiro
```

No LLM/embedding API keys needed — the config refactor (see below) ensures the dashboard can import `@mashiro/db` and `@mashiro/shared` without triggering validation for those keys.

## Running

```bash
npm run dev          # starts both bot and dashboard via turbo
# or
cd apps/dashboard && npm run dev   # dashboard only (port 3000)
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Overview — stat cards (conversations, memories, facts, reminders), emotional trend chart, recent activity feed |
| `/conversations` | Paginated table of all conversation sessions with status, message count, platform, dates |
| `/conversations/[id]` | Conversation detail — header metadata + scrollable message history with chat bubbles |
| `/memories` | Tabbed view by type (fact/episode/milestone/working) with count badges, paginated |
| `/reminders` | Reminder table with message, fire time, status (pending/fired), toggle to show fired |
| `/api/images/[key]` | GridFS image proxy — serves stored images by key with immutable cache headers |

## Architecture

### Data Flow

```
MongoDB ← ensureDB() ← query functions ← server components (pages)
```

All pages are React Server Components. No client-side data fetching. The only client component is `NavLink` (for `usePathname()` active route highlighting).

### DB Connection

`src/lib/db.ts` — Mongoose singleton cached on `globalThis` to survive Next.js HMR. Every server component calls `await ensureDB()` before querying.

### Query Layer

All in `src/lib/queries/`:

- `overview.ts` — `getOverviewStats()`, `getEmotionalTrend()`, `getRecentActivity()`
- `conversations.ts` — `getConversationList(page)`, `getConversationDetail(id)`
- `memories.ts` — `getMemoriesByType(type, page)`, `getMemoryTypeCounts()`
- `reminders.ts` — `getReminderList(showFired?)`

Queries use `@mashiro/db` models directly. `@mashiro/memory` is **not** imported (it depends on Google AI SDK which is unnecessary for read-only display).

### Config Refactor

`@mashiro/shared/config.ts` was split into:
- **Base parse** (always succeeds) — validates structure + defaults, no API key requirements
- **`validateConfig()`** — strict check for LLM/embedding keys, called explicitly by the bot at startup

This allows the dashboard to import `@mashiro/db` → `@mashiro/shared` without `process.exit(1)` from missing API keys.

### Next.js Config

- `transpilePackages` for `@mashiro/*` workspace packages
- `serverExternalPackages` for `mongoose`, `pino`, `pino-pretty` (Node.js native modules)
- Webpack `extensionAlias` to resolve `.js` → `.ts` for internal packages that use TypeScript ESM import conventions

## Components

| Component | Type | Purpose |
|-----------|------|---------|
| `sidebar.tsx` | Server | Nav sidebar with page links |
| `nav-link.tsx` | Client | Active route highlighting via `usePathname()` |
| `stat-card.tsx` | Server | Reusable stats card (icon, label, value) |
| `emotional-indicator.tsx` | Server | Trend badge (rising/falling/stable) |
| `activity-feed.tsx` | Server | Recent conversations + memories interleaved by time |
| `message-bubble.tsx` | Server | Chat message with role-based styling, tool call display |
| `memory-card.tsx` | Server | Memory content with importance/type badges |
| `pagination.tsx` | Server | Simple prev/next page links |

## Dependencies

Dashboard-specific (beyond monorepo shared):
- `tailwindcss` v4 + `@tailwindcss/postcss` — CSS framework
- `class-variance-authority`, `clsx`, `tailwind-merge` — shadcn/ui utilities
- `lucide-react` — icons
- `radix-ui` — shadcn/ui primitives (card, badge, table, tabs, scroll-area, separator)
