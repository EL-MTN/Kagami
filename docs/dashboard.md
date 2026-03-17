# Dashboard

Web dashboard for managing and inspecting Mashiro's data, built with Next.js 15 + Tailwind CSS v4 + shadcn/ui.

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
| `/workflows`            | Workflow table with name, schedule, status, last run time                                                      |
| `/workflows/[id]`       | Workflow detail — configuration + execution history log                                                        |
| `/skills`               | Skill management — table with enable/disable, create, import, export                                           |
| `/skills/[id]`          | Skill detail — inline editor (prompt, params, cron, report mode) + execution log history                       |
| `/api/skills`           | GET list, POST create, POST `?action=import` bulk import                                                       |
| `/api/skills/export`    | GET — download all skills as versioned JSON bundle                                                             |
| `/api/skills/[id]`      | GET detail, PATCH update, DELETE                                                                               |
| `/api/skills/[id]/logs` | GET paginated execution logs (cursor-based via `?before=`)                                                     |
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
- `workflows.ts` — `getWorkflowList()`, `getWorkflowDetail(id)`
- `skills.ts` — `getSkillList()`, `getSkillDetail(id)`, `getSkillLogList(skillId, limit, before?)`

Queries use `@mashiro/db` models directly. `@mashiro/memory` is **not** imported (it depends on Google AI SDK which is unnecessary for read-only display).

### Validation

`src/lib/skill-schema.ts` — Zod schemas shared between API route handlers (server-side validation) and client components (live validation). Exports: `skillCreateSchema`, `skillPatchSchema`, `skillExportBundleSchema`, and inferred TypeScript types. Zero Node.js-specific imports so it works in both runtimes.

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

| Component                        | Type   | Purpose                                                     |
| -------------------------------- | ------ | ----------------------------------------------------------- |
| `sidebar.tsx`                    | Server | Nav sidebar with page links                                 |
| `nav-link.tsx`                   | Client | Active route highlighting via `usePathname()`               |
| `stat-card.tsx`                  | Server | Reusable stats card (icon, label, value)                    |
| `emotional-indicator.tsx`        | Server | Trend badge (rising/falling/stable)                         |
| `activity-feed.tsx`              | Server | Recent conversations + memories interleaved by time         |
| `message-bubble.tsx`             | Server | Chat message with role-based styling, tool call display     |
| `memory-card.tsx`                | Server | Memory content with importance/type badges                  |
| `pagination.tsx`                 | Server | Simple prev/next page links                                 |
| `skills/skill-table.tsx`         | Client | Interactive skill list with enable/disable, delete          |
| `skills/skill-editor.tsx`        | Client | Inline skill editing with live cron preview, dirty tracking |
| `skills/skill-create-dialog.tsx` | Client | New skill creation dialog                                   |
| `skills/skill-import-dialog.tsx` | Client | Drag-drop/paste JSON import with preview                    |
| `skills/skill-delete-dialog.tsx` | Client | Confirm delete dialog                                       |
| `skills/skill-log-table.tsx`     | Client | Execution logs with expandable summaries, load more         |
| `skills/parameter-editor.tsx`    | Client | Dynamic parameter list editor with type-aware defaults      |

## Dependencies

Dashboard-specific (beyond monorepo shared):

- `tailwindcss` v4 + `@tailwindcss/postcss` — CSS framework
- `class-variance-authority`, `clsx`, `tailwind-merge` — shadcn/ui utilities
- `lucide-react` — icons
- `radix-ui` — shadcn/ui primitives (card, badge, table, tabs, scroll-area, separator, dialog, switch)
- `zod` — request/response validation (shared between API routes and client components)
- `cron-parser` — computing `nextRunAt` from cron expressions on skill create/update
- `cronstrue` — human-readable cron descriptions
