# Kizuna CRM Client

`@kokoro/kizuna` is Kokoro's client for Kizuna relationship data. It gives the bot compact CRM context on demand, plus concierge-style write helpers (interaction logs, followups, person edits) that the bot exposes only behind the confirmation primitive.

## Configuration

Defined in `@kokoro/shared`:

| Env var      | Default                        | Behavior                      |
| ------------ | ------------------------------ | ----------------------------- |
| `KIZUNA_URL` | `https://api.kizuna.localhost` | Base URL for Kizuna API calls |

Kokoro sends no `Authorization` header to Kizuna. The integration matches Kizuna's single-user localhost API model. Reads are unconditional; writes always go through the confirmation primitive so Goshujin-sama approves before any mutation lands.

## Package Surface

Source lives in `packages/kizuna/src/`:

- `client.ts` — GET/POST/PATCH/DELETE `tracedFetch` wrapper (`getJson` for reads, `sendJson` for writes), shared 10 s deadline helpers, sanitized `KizunaClientError`. Every outgoing call carries the active W3C `traceparent`, so a Telegram message can be followed end-to-end across Kokoro → Kizuna in the Kansoku trace waterfall.
- `schemas.ts` — Kizuna wire schemas and compact LLM-facing types.
- `projections.ts` — `PersonSummary`, `InteractionSummary`, `FollowupSummary`, excerpts, missing-person placeholder.
- `people.ts` — `findPeople`, `getPerson`, `getPersonContext`, `updatePerson`.
- `interactions.ts` — `recentInteractions`, `listInteractionsForPerson`, `logInteraction`.
- `followups.ts` — `listFollowups`, `listMyFollowups`, `listFollowupsForPerson` with de-duped person hydration, `createFollowup`, `resolveFollowup`.

## Tool Integration

`apps/bot/src/ai/tools/crm.ts` exposes the package as model-facing tools:

Read tools (called directly):

- `findPeople({ query, limit? })` → `GET /people?identityQuery=...`.
- `getPersonContext({ personId })` → profile, recent interactions, open followups under one shared deadline.
- `recentInteractions({ personId, channel?, since?, limit? })` → `sort=occurredAt:-1`.
- `listMyFollowups({ direction?, status?, limit? })` → `sort=duePriority:1`, hydrated with compact person summaries.

Write tools (always wrapped in `requestConfirmation`; see [confirmations.md](confirmations.md)):

- `logInteraction({ occurredAt, channel, title, body?, participants, context?, location? })` → `POST /interactions`.
- `createFollowup({ personId, direction, reason, dueAt?, sourceInteractionId? })` → `POST /followups`, then hydrates the followup's person for the compact summary.
- `resolveFollowup({ followupId, status, dueAt?, reason? })` → `PATCH /followups/:id`.
- `updatePerson({ personId, displayName?, primaryEmail?, primaryOrgId?, relationship?, emails?, phones?, handles?, tags?, birthday?, notes? })` → `PATCH /people/:id`.

The confirmation gate is **code-enforced** for these four tools: each write tool's `execute` body returns a refusal envelope instead of calling Kizuna, telling the LLM to retry through `requestConfirmation`. The gated dispatcher in `apps/bot/src/services/gated-actions.ts` invokes the `@kokoro/kizuna` client function directly after the user approves, so the dispatch path is unaffected. Input schemas live in `apps/bot/src/ai/tools/crm.ts` and are imported by the dispatcher so the tool and re-validator stay in sync.

The read tools are always included in `allTools`, `watcherTools`, and `routineToolsUnderWatcher`. The write tools are always included in `allTools` only — `watcherTools` and `routineToolsUnderWatcher` stay read-only by construction. All tools return sanitized degraded envelopes on transport failures, timeouts, non-404 HTTP failures, and schema mismatches so conversation generation can continue.

## Testing

Package tests live in `packages/kizuna/tests/` and use MSW to assert:

- No auth header on any request.
- URL mapping for `identityQuery`, `occurredAfter`, `occurredAt:-1`, and `duePriority:1` (reads).
- Method + body shape for `POST /interactions`, `POST /followups`, `PATCH /followups/:id`, and `PATCH /people/:id` (writes).
- Compact projections and excerpt truncation.
- Followup hydration de-duplication, order preservation, and missing-person fallback.
- `KizunaClientError` classification and redaction.

Bot tool tests mock `@kokoro/kizuna` so tool-envelope behavior stays isolated from HTTP parsing.
