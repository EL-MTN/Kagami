# Testing

Mashiro has a layered automated-test suite that runs in-memory and finishes in
under 15 s on a laptop. This doc describes how it's organized, what's
covered, and how to add tests.

## Goals

1. Catch regressions in correctness invariants — atomic transitions, state
   machines, schema migrations.
2. Document tool / adapter contracts via executable examples.
3. Stay cheap. No live LLM/API calls in the default run.
4. Be the source of truth for behavior — when a test and the bot disagree,
   we fix the bot, not the test.

## Stack

- **Test runner:** Vitest 4.1.5 (native ESM, no transpile step). Runs all
  packages in one process via the `projects` array in the root
  `vitest.config.ts`.
- **DB tests:** `mongodb-memory-server` per worker via the `withTestDb()`
  helper. After connect, every registered Mongoose model has its indexes
  synced so partial-unique constraints fire deterministically (Mongoose's
  default `autoIndex: true` builds in the background).
- **LLM tests:** Vercel AI SDK v6's `MockLanguageModelV3` (from `ai/test`),
  scripted via the `mockLLM(scripts)` helper.
- **Embeddings:** stubbed to a deterministic L2-normalized hash bucket so
  similarity ordering is stable without calling Google.
- **External HTTP:** MSW for fetch interception (Gmail, Calendar, BlueBubbles,
  Telegram CDN, Whisper).
- **Timer-driven schedulers:** `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`.
- **Naming:** `<src-path>.test.ts` mirrored under `tests/`. e.g.
  `apps/bot/src/stt/transcriber.ts` →
  `apps/bot/tests/stt/transcriber.test.ts`.

## Commands

```bash
npm run test              # run everything (~10 s)
npm run test:watch        # vitest watch mode
npm run test:coverage     # V8 coverage; HTML report at coverage/index.html
```

## Layout

```
mashiro/
├── apps/
│   └── bot/
│       └── tests/                  # mirrors src/ tree
│           ├── ai/
│           │   ├── tools/          # one test file per LLM tool
│           │   └── response.test.ts
│           ├── platform/
│           ├── services/
│           └── stt/
├── packages/
│   ├── shared/tests/
│   ├── db/tests/
│   ├── memory/tests/
│   └── test-utils/                 # internal package
│       └── src/
│           ├── db.ts               # withTestDb() — Mongo lifecycle + index sync
│           ├── llm.ts              # mockLLM() → MockLanguageModelV3
│           ├── embeddings.ts       # mockEmbeddings() — deterministic vectors
│           ├── platform.ts         # fakeAdapter(), fakeIncoming()
│           ├── http.ts             # MSW server with default handlers
│           ├── time.ts             # advanceTimersByAsync helper
│           └── fixtures/
├── vitest.config.ts                # `projects` config + coverage settings
└── tests/
    └── e2e/                        # cross-package pipeline tests (planned)
```

## Source-of-truth principle

When a test fails because production behaves differently than the test
expects, fix the bot — not the test. If a test needs to encode a quirk on
purpose, leave a comment explaining why. The point of the suite is to pin
correct behavior, not to mirror current behavior.

Real bugs fixed this way so far:

- `apps/bot/src/stt/transcriber.ts` — `parseProviderSpec` ran outside the
  try/catch, so a malformed `STT_PROVIDER` threw uncaught instead of
  returning the documented `SttOutcome`. Moved inside try.
- `packages/shared/src/config.ts` + `apps/bot/src/stt/providers/openai-stt.ts`
  — `STT_API_KEY ?? OPENAI_API_KEY` used nullish coalescing in both the
  validator and the runtime provider, so `STT_API_KEY=""` (the shape
  `STT_API_KEY=` produces in `.env`) wouldn't fall through. Changed both
  to `||` — they have to agree, otherwise validateConfig passes startup
  but the provider still hands `""` to `createOpenAI`.
- `apps/bot/src/ai/tools/use-routine.ts` — two related fixes in
  `buildParamSchema`:
  - `z.coerce.string()` accepts `undefined` and produces the literal
    `"undefined"`, so a required string param called without a value
    silently slipped through. Replaced with
    `z.union([z.string(), z.number(), z.boolean()]).transform(String)` —
    rejects undefined while preserving the original hand-rolled
    validator's tolerance for LLMs returning `42` or `true` for a
    string-typed field.
  - Defaults are applied via `z.preprocess` (substitute the default for
    `undefined` _before_ the type schema runs) instead of `field.default()`.
    Zod 4's `.default()` short-circuits the entire pipeline for undefined
    inputs — meaning transforms and coercions don't run on default values,
    so a string-typed param with `default: 42` would surface the number
    `42` downstream. The preprocess form runs the default through the same
    coercion path as a present value.

## Coverage map (current state)

This is the **current** view — which modules have tests, which don't.
Update the tables here when a test file lands or moves.

Deliberately not tracking line/branch percentages in this doc — they drift
on every commit and create maintenance noise without meaningfully changing
the answer to "is this module tested?". For ad-hoc drilldowns, run
`npm run test:coverage`; the V8 HTML report at `coverage/index.html` has
the line-level detail.

Legend: ✅ has tests, 🟡 partial — happy path only or one branch missing,
❌ no tests, ⏭ deferred — covered in a later phase or intentionally
untested (thin wrapper, init code).

### `packages/shared/src/`

| File                    | Status | Test file                          | Notes                                                                                                 |
| ----------------------- | ------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `config.ts`             | ✅     | `tests/config.test.ts`             | All `validateConfig` branches; module-level Zod parse exercised via `vi.stubEnv` + `vi.resetModules`. |
| `geo.ts`                | ✅     | `tests/geo.test.ts`                | Reference distances (NYC↔London, antipodes, equator step, identity).                                  |
| `markdown.ts`           | ✅     | `tests/markdown.test.ts`           | `parseMarkdown` — no writer exists.                                                                   |
| `routine-validation.ts` | ✅     | `tests/routine-validation.test.ts` | `computeNextRunAt` + every `validateCronAndDefaults` branch.                                          |
| `logger.ts`             | ⏭     | —                                  | Pino wrapper. Exercised transitively wherever it's imported.                                          |
| `types.ts`              | n/a    | —                                  | Type-only; excluded from coverage.                                                                    |

### `packages/db/src/`

| File                             | Status | Test file                                   | Notes                                                                                                                      |
| -------------------------------- | ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `connection.ts`                  | ✅     | `tests/connection.test.ts`                  | Happy path, exit-on-failure, disconnect, `isDuplicateKeyError`. Mongoose mocked at the module level.                       |
| `gridfs.ts`                      | ✅     | `tests/gridfs.test.ts`                      | Image + audio bucket roundtrips, isolation, batch removes, mimeType fallback.                                              |
| `models/conversation.ts`         | ✅     | `tests/models/conversation.test.ts`         | `getOrCreateSession` platform scoping, idle cutover, append/clear/trim/cleanup. GridFS removers mocked.                    |
| `models/pending-confirmation.ts` | ✅     | `tests/models/pending-confirmation.test.ts` | Atomic CAS under concurrent verdicts; list filters; `attachResultText`.                                                    |
| `models/watcher.ts`              | ✅     | `tests/models/watcher.test.ts`              | CRUD, partial-unique name index, `getDue` filters, observation/state-only contract, manual-claim atomicity, log lifecycle. |
| `models/routine.ts`              | ✅     | `tests/models/routine.test.ts`              | CRUD, `getDueRoutines`, atomic manual-claim, parent-log linkage, log cleanup.                                              |
| `models/reminder.ts`             | ✅     | `tests/models/reminder.test.ts`             | Pending/listed/recently-fired filters, fire-then-cleanup.                                                                  |
| `models/memory.ts`               | ✅     | (transitive via `engine.test.ts`)           | Schema reached by every `remember` / `recall` test.                                                                        |
| `models/scheduler-state.ts`      | ❌     | —                                           | `getNextProactiveAt` / `setNextProactiveAt` untested — used by the proactive scheduler.                                    |
| `models/location-history.ts`     | ❌     | —                                           | Location-history queries untested.                                                                                         |
| `models/token-usage.ts`          | ❌     | —                                           | Usage aggregation queries untested.                                                                                        |

### `packages/memory/src/`

| File           | Status | Test file              | Notes                                                                                                                                          |
| -------------- | ------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`    | ✅     | `tests/engine.test.ts` | `remember` / `recall` ranking, archive exclusion, type+minScore filters, follow-ups, working memory, baseline.                                 |
| `embedding.ts` | 🟡     | (cosineSimilarity)     | `cosineSimilarity` exercised by recall tests via the un-mocked path. `generateEmbedding` is fully stubbed (calls Google Gemini in production). |

### `apps/bot/src/`

| File                                                                                                                               | Status | Test file                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform/registry.ts`                                                                                                             | ✅     | `tests/platform/registry.test.ts`        | `platformForChatId`, `imessageChatId`, `AdapterRegistry`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `platform/telegram/format.ts`                                                                                                      | ✅     | `tests/platform/telegram/format.test.ts` | Markdown→HTML conversions, escape order, composition.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stt/transcriber.ts`                                                                                                               | ✅     | `tests/stt/transcriber.test.ts`          | Caps, `SttOutcome` states, openai-provider happy path with mocked downstream.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `services/gated-actions.ts`                                                                                                        | ✅     | `tests/services/gated-actions.test.ts`   | sendEmail, manageCalendar (update + delete), browseAgent (happy + truncation + Target/Browser-closed reset path).                                                                                                                                                                                                                                                                                                                                                                          |
| `ai/response.ts`                                                                                                                   | ✅     | `tests/ai/response.test.ts`              | `extractResponseText`, `collectToolCalls`, `wasPhotoSent`, `sendSegmented`, `logSteps`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ai/tools/*` (21 files including `index.ts`)                                                                                       | ✅     | `tests/ai/tools/*.test.ts`               | Every LLM tool covered: memory tools, service wrappers (send-email/photo/voice, check-email, manage-calendar incl. readOnly), CRUD+lifecycle (manage-routines/watchers/reminders, search-routines, report-watcher-result), nesting + purity gate (use-routine), confirmation primitives (request/cancel-confirmation), browse (full + readOnly), and the `index.ts` registry (allTools env-gating, watcherTools read-only invariant, routineToolsUnderWatcher transitive read-only check). |
| `platform/telegram/adapter.ts`                                                                                                     | ❌     | —                                        | Telegram-side `PlatformAdapter` impl. Pipeline phase.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `platform/telegram/bot.ts`                                                                                                         | ❌     | —                                        | Bot wiring + callback_query handler. Pipeline phase.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `platform/imessage/{adapter,client,webhook}.ts`                                                                                    | ❌     | —                                        | iMessage stack. Pipeline phase.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ai/{acknowledge,context-assembler,generate,prompts,provider,token-tracker}.ts`                                                    | ❌     | —                                        | Generate pipeline + prompt assembly. Pipeline phase.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `services/{browser,confirmation-events,geocoding,gmail,google-auth,google-calendar,location,routine-executor,watcher-executor}.ts` | ❌     | —                                        | Service implementations. Reached transitively by the gated-action and tool-contract tests; the executors themselves are pipeline phase.                                                                                                                                                                                                                                                                                                                                                    |
| `scheduler/{proactive,reminders,routines,watchers}.ts`                                                                             | ❌     | —                                        | Timer-driven loops. Pipeline phase with `vi.useFakeTimers()`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stt/providers/openai-stt.ts`                                                                                                      | ❌     | —                                        | Provider-specific HTTP call. Will be exercised via MSW in a transcriber-pipeline test.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tts/**`                                                                                                                           | ❌     | —                                        | TTS generator + providers. Not scheduled — text-only paths dominate today.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `context/generator.ts`                                                                                                             | ❌     | —                                        | Context assembly. Pipeline phase.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `memory/curator.ts`                                                                                                                | ❌     | —                                        | Memory consolidation pipeline. Pipeline phase.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### `apps/dashboard/src/`

Not in scope. The Next.js dashboard has its own testing concerns (Server
Components, route handlers, queries) — revisit after the bot is fully
covered.

## Mocking strategy

| Surface                         | Approach                                                                    | Helper                               |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| MongoDB                         | `mongodb-memory-server` per test file; truncate between tests               | `@mashiro/test-utils` `withTestDb()` |
| LLM (Vercel AI SDK v6)          | `vi.mock("../provider")` returning a `MockLanguageModelV3` (from `ai/test`) | `mockLLM({ scripts })`               |
| Embeddings                      | Stub `generateEmbedding` to deterministic vector (hash → bucket)            | `mockEmbeddings()`                   |
| `PlatformAdapter`               | In-memory recorder, assertable via `adapter.calls.<method>`                 | `fakeAdapter()`                      |
| BlueBubbles HTTP                | MSW handlers                                                                | `setupMswServer()`                   |
| Gmail / Calendar (`googleapis`) | `vi.mock` the service module per test                                       | (per-test)                           |
| Whisper / OpenAI STT            | MSW handler returning `{ text, durationInSeconds }`                         | bundled in `setupMswServer()`        |
| Stagehand (browser)             | `vi.mock("../../services/browser")` per test                                | (per-test)                           |
| Timers (schedulers)             | `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`                        | `advanceTimersByAsync(ms)`           |
| File system (soul.md, fixtures) | Real reads from `packages/test-utils/src/fixtures/`                         | (no helper needed)                   |
| Pino logger                     | `vi.mock("@mashiro/shared", ...)` overriding only `logger`                  | (per-test)                           |

## Patterns worth knowing

- **Tool tests cast the SDK Tool type to `{ execute: (input, opts?) => ... }`**
  via an `unknown` step, then call `execute()` directly. The Zod inputSchema
  is bypassed in tests, but runtime guards inside `execute` (e.g.
  `isGatedTool`) still fire — pin those.
- **Hoisted mocks for shared fixtures.** `vi.mock` factories are hoisted
  above imports; for mutable state (like a per-test config object), declare
  it via `vi.hoisted(() => ({ ... }))` so the factory can read it.
  Always `mockReset` in `beforeEach` — call history accumulates across `it`s
  in the same file.
- **Module reset for module-level state.** Modules that capture state at
  import time (notably `packages/shared/src/config.ts`'s Zod parse of
  `process.env`) need `vi.resetModules()` plus a dynamic `await import(...)`
  to re-evaluate per test scenario.
- **`process.exit` sentinel.** Production code that exits on misconfig
  (`config.ts`, `connection.ts`) is tested by spying on `process.exit` with
  a mock that throws a sentinel error — letting the suite assert "exit was
  called with code N" via `await expect(fn()).rejects.toThrow(Sentinel)`.

## What's left

What we have today (~408 tests, ~10 s) covers pure functions, DB models,
and tool contracts. Two phases remain:

- **Pipeline tests.** Real DB, `mockLLM`, fake timers, MSW. Generate-pipeline
  goldens, Telegram callback_query flows, iMessage webhook YES/NO parser,
  proactive scheduler timer recovery, watcher and routine executors.
  `tests/e2e/` at the root for cross-package flows.
- **Live-service smoke (optional).** Gated behind `RUN_LIVE_TESTS=true`.
  Real Anthropic/Whisper/Telegram round-trips. Skipped by default in CI;
  release-checklist only.

## Open decisions

1. **Coverage gating.** No floor today. Could be introduced as a
   touched-files check rather than a global percentage so the bar tracks
   what changed instead of the whole repo.
2. **CI.** `.github/workflows/test.yml` runs typecheck + lint + test on
   every PR and on pushes to master. The husky pre-commit hook also runs
   the full suite (after lint-staged); use `git commit --no-verify` to
   bypass when iterating quickly. If the suite ever gets slow enough that
   pre-commit feels sluggish (~10 s today), move it to a pre-push hook
   instead.
3. **Dashboard tests.** The Next.js dashboard is out of scope until the bot
   side is fully covered.
