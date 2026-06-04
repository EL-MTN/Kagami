# Testing

Kioku has a small but growing automated-test suite. Pure helpers are tested without any infrastructure; everything that touches Mongo runs against `mongodb-memory-server` (vanilla mongo, no Atlas Search). The suite finishes in seconds and runs fully offline.

## Goals

1. Catch regressions in correctness invariants — atomic transitions, dedup semantics, scope boundaries, audit-log completeness.
2. Document the storage contract via executable examples (per-collection tests).
3. Stay cheap. No live LLM/API calls in the default run; embeddings + extraction calls are not exercised in tests.
4. Be the source of truth for behavior — when a test and the API disagree, fix the API, not the test.

## Stack

- **Test runner:** Vitest (`vitest run`), driven by `npm run test` which is `turbo run test` → `apps/api`'s test script. Config lives at `kioku/vitest.config.ts`; the `apps/api/tests/**/*.test.ts` glob is anchored to the project root.
- **Mongo:** one `mongodb-memory-server` `MongoMemoryReplSet` (`count: 1`) booted by Vitest's `globalSetup` (`apps/api/tests/global-setup.ts`) and shared across the whole run. Each test file calls `setupTestMongo(<facet>)` in `beforeAll` to point Kioku's lazy mongo singleton at a unique database name on that shared instance, and `teardownTestMongo` in `afterAll` to reset the singleton so the next file in the same worker connects fresh.
- **Index setup:** `ensureIndexes({ allowMissingSearch: true })` — `mongodb-memory-server` is vanilla mongo without mongot. `$listSearchIndexes` throws before any embed call would happen, and `allowMissingSearch` swallows that error. No embedding provider is reached.
- **LLM-touching code:** no live provider is reached. Where an LLM/embedding path is tested, the `ai` SDK is mocked (`ingest-session.test.ts` forces every batch to reject, covering the all-batches-fail error path) or only its non-LLM short-circuit is checked (`relevance.test.ts`). The bulk of the suite focuses on pure helpers (`scoring.ts`, `text.ts`, `query/answer.ts` formatters), storage primitives (`appendFacts`, `recordEvents`, `parseTranscript`), and route handlers (`meta.test.ts`, `rate-limit.test.ts`).

## Layout

```
apps/api/tests/
├── facts.test.ts             # appendFacts roundtrip, scope reads, category/metadata persistence
├── entities.test.ts          # upsertEntitiesFromFacts race semantics
├── history.test.ts           # ADD events + readHistoryFor newest-first
├── ingest-session.test.ts    # session-ingest "all batches fail" path throws a retryable error (ai SDK mocked to reject)
├── meta.test.ts              # meta router (/health, /version, /meta/categories) over a real express server
├── mongo.test.ts             # ensureIndexes idempotency + index shapes
├── query.test.ts             # answer.ts formatters + citation helpers (pure)
├── rate-limit.test.ts        # createPerMinuteRateLimit + parseRateLimitPerMinute
├── relevance.test.ts         # filterDurableFacts empty-input short-circuit (no LLM invoked)
├── scoring.test.ts           # scoring.ts + text.ts (pure)
├── session-summary.test.ts   # cache hit/miss semantics
├── transcript.test.ts        # parseTranscript shape
├── logger.test.ts            # stable service/component/env bindings on the @kagami/logger wrapper
├── helpers/                  # shared mongo + http test harness
└── fixtures/
    └── transcript-1.md
```

Tests live under `apps/api/tests/`. There is no mirror-the-src convention — files are named after the contract they exercise.

## Patterns

### DB harness (shared replSet, per-file database)

```ts
import { afterAll, beforeAll, beforeEach } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

beforeAll(async () => {
  setupTestMongo("<facet>");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("facts").deleteMany({});
});

afterAll(teardownTestMongo);
```

`setupTestMongo` reads the suite-wide replSet URI exposed by `global-setup.ts` and points Kioku's lazy mongo singleton at a per-file database (`kioku_<facet>_test_<random>`). `teardownTestMongo` calls `closeMongo()`, which resets the singleton's cached client / dbName so the next file running in the same worker connects fresh.

The dynamic `import()` in `beforeAll`/`beforeEach` is deliberate — it loads the storage modules **after** the env vars are set, so the lazy Mongo singleton in `mongo.ts` picks up the test URI on first connect.

### Pure-helper tests

Direct imports, no setup:

```ts
import { expect, it } from "vitest";
import { lemmatizeForBm25 } from "../src/retrieval/text.ts";

it("lemmatizeForBm25 lowercases, drops stopwords, stems suffixes", () => {
  const out = lemmatizeForBm25("I was meeting with Alex about the meetings");
  expect(out).toContain("meet");
  expect(out).toContain("alex");
});
```

## Commands

```bash
npm run test              # all packages via turbo (api + dashboard)
# or, scoped to the api workspace:
cd apps/api && npm test
```

Turbo's `test` task depends on `^build`, but neither workspace has a build step that produces a build artifact for tests, so test runs are direct.

## What's covered

| Area                  | Coverage                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Storage primitives    | `facts.test.ts`, `entities.test.ts`, `history.test.ts`, `mongo.test.ts`                                                             |
| Index setup           | `mongo.test.ts` — btree shapes + idempotency                                                                                        |
| Transcript parsing    | `transcript.test.ts` (frontmatter, turn parsing, heading exclusion)                                                                 |
| Scoring + text utils  | `scoring.test.ts`                                                                                                                   |
| Answerer formatters   | `query.test.ts` (`formatFactsGroupedByDateNewestFirst`, `stripMemThinking`, `deriveQuestionDate`, `extractCitations`)               |
| Bench scoring         | `query.test.ts` (`computeCitationRecall` from `scripts/citation-recall.ts` — set-overlap recall, dedup, undefined-on-missing-truth) |
| Session-summary cache | `session-summary.test.ts`                                                                                                           |
| Logger bindings       | `logger.test.ts` — stable `service`/`component`/`env` on the `@kagami/logger` wrapper                                               |

## What's not covered (yet)

- The hybrid ranker pipeline end-to-end (`defaultFactRanker` against a populated DB).
- LLM-driven happy paths (`consolidate` extraction, `appendSingleFact` cosine dedup, narrative summary generation, answerer). Only the `consolidate` all-batches-fail error path is covered today (`ingest-session.test.ts`, with the `ai` SDK mocked to reject); the success paths would need stubbed embeddings + a faked provider to run offline.
- The MCP transport (`mcp.ts`) is untested. Among REST routers only the meta router is hit directly so far (`meta.test.ts` mounts it on a real express server); the facts/recall/query/sessions routers are still exercised only indirectly through the storage layer.
- The dashboard.

When adding tests for these, the rule is the same as Kokoro's: no live LLM/API calls in the default run. Stub embeddings via `vi.fn()` and inject the faked provider rather than calling out.

## Adding a test

1. Pick a name — `apps/api/tests/<contract>.test.ts`. No mirror-the-src convention.
2. If the contract needs Mongo, copy the harness block above with a fresh DB suffix.
3. Import `it`/`expect`/lifecycle hooks from `"vitest"`.
4. Use `import("...")` inside lifecycle hooks when env vars must be set first; top-level imports are fine for pure helpers.
5. Keep assertions on observable behavior (return values, DB state) rather than internal call shapes.
