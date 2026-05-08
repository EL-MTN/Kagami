# Kizuna CRM Client

`@kokoro/kizuna` is Kokoro's read-only client for Kizuna relationship data. It gives the bot compact CRM context on demand without adding write paths from Kokoro into Kizuna.

## Configuration

Defined in `@kokoro/shared`:

| Env var          | Default                        | Behavior                                     |
| ---------------- | ------------------------------ | -------------------------------------------- |
| `KIZUNA_URL`     | `https://api.kizuna.localhost` | Base URL for Kizuna API calls                |
| `KIZUNA_ENABLED` | `true`                         | When `false`, CRM tools are omitted entirely |

Kokoro sends no `Authorization` header to Kizuna. The v1 integration matches Kizuna's single-user localhost API model; the read-only invariant is enforced by this package and the bot tool palette.

## Package Surface

Source lives in `packages/kizuna/src/`:

- `client.ts` — GET-only fetch wrapper, shared 10 s deadline helpers, sanitized `KizunaClientError`.
- `schemas.ts` — Kizuna wire schemas and compact LLM-facing types.
- `projections.ts` — `PersonSummary`, `InteractionSummary`, `FollowupSummary`, excerpts, missing-person placeholder.
- `people.ts` — `findPeople`, `getPerson`, `getPersonContext`.
- `interactions.ts` — `recentInteractions`, `listInteractionsForPerson`.
- `followups.ts` — `listFollowups`, `listMyFollowups`, `listFollowupsForPerson` with de-duped person hydration.

Exported package functions are reads only. Do not add POST/PATCH/DELETE helpers here without a separate writeback design.

## Tool Integration

`apps/bot/src/ai/tools/crm.ts` wraps the package as four model-facing tools:

- `findPeople({ query, limit? })` → `GET /v1/people?identityQuery=...`.
- `getPersonContext({ personId })` → profile, recent interactions, open followups under one shared deadline.
- `recentInteractions({ personId, channel?, since?, limit? })` → `sort=occurredAt:-1`.
- `listMyFollowups({ direction?, status?, limit? })` → `sort=duePriority:1`, hydrated with compact person summaries.

The tools are included in `allTools`, `watcherTools`, and `routineToolsUnderWatcher` when `KIZUNA_ENABLED` is true. They return sanitized degraded envelopes on disabled config, transport failures, timeouts, non-404 HTTP failures, and schema mismatches so conversation generation can continue.

## Testing

Package tests live in `packages/kizuna/tests/` and use MSW to assert:

- GET-only requests and no auth header.
- URL mapping for `identityQuery`, `occurredAfter`, `occurredAt:-1`, and `duePriority:1`.
- Compact projections and excerpt truncation.
- Followup hydration de-duplication, order preservation, and missing-person fallback.
- `KizunaClientError` classification and redaction.
- Consumer fixture coverage against `tests/fixtures/kizuna-manifest.v1.json`.

Bot tool tests mock `@kokoro/kizuna` so tool-envelope behavior stays isolated from HTTP parsing.
