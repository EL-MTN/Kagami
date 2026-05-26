# Testing

Kizuna's test suite covers the API workspace. Pure helpers run with no infrastructure; everything that touches Mongo or Express runs against a real MongoDB instance started by `mongodb-memory-server` (no Docker required) plus an in-process Express app via `supertest`. The dashboard has no automated tests today.

## Goals

1. Catch regressions in correctness invariants — soft-delete semantics, cursor shapes, dedup via `sourceRef`, Kao token-vend + self-heal retry, ingest pause/resume.
2. Document the API contract via executable examples (per-resource endpoint tests and the Kokoro consumer contract).
3. Stay cheap. No live Google calls — the Gmail and Calendar clients are interfaces, and tests inject `FakeGmailClient` / `FakeCalendarClient` implementations.
4. Be the source of truth for behavior — when a test and the API disagree, fix the API, not the test.

## Stack

- **Test runner:** Vitest 4 with the default node pool. Configured at `kizuna/vitest.config.ts` (project root, not the API workspace):
  - `pool: 'forks'`, `fileParallelism: false`, `isolate: false` — every test file shares one worker, which lets a single MongoDB instance be reused across files in a run.
  - `globalSetup: ['./apps/api/tests/global-setup.ts']` — boots one `MongoMemoryServer` in the parent process before workers spawn and exposes its URI via `__VITEST_SHARED_MONGO_URI__`. The server is stopped on suite teardown.
  - `setupFiles: ['./apps/api/tests/setup.ts']` — defaults `LOG_LEVEL` to `silent` so pino doesn't spam test output. Override with `LOG_LEVEL=debug npm test` when triaging a flaky run.
  - `testTimeout: 60_000`, `hookTimeout: 60_000`.
  - `include: ['apps/api/tests/**/*.test.ts']`.
- **MongoDB:** real `mongod` started in-process by `mongodb-memory-server`. One instance is shared across the whole run via vitest `globalSetup`; each `startHarness()` call connects to a unique database name (`kizuna_test_<random>`) on that instance. `connectDb` runs `syncIndexes` so partial-unique indexes (notably `interactions_sourceRef_unique`) fire correctly. On `stop()` the harness drops its database before disconnecting.
- **HTTP:** `supertest` against a live `createApp({ db, config })`. No port binding — `supertest` invokes the request handler directly.
- **Google APIs:** never actually called.
  - `OAuth2Client.prototype.getToken` is `vi.spyOn`'d in OAuth tests.
  - Gmail / Calendar clients are interfaces: tests inject `FakeGmailClient` / `FakeCalendarClient` (`apps/api/tests/helpers/fake-{gmail,calendar}.ts`). The real clients (`makeGmailClient` / `makeCalendarClient`) are dynamically imported only by `runGmailSyncOnce` / `runCalendarSyncOnce`, which are bypassed in tests in favor of `runGmailSync({ client })` / `runCalendarSync({ client })`.
- **Encryption:** real `aes-256-gcm` with a per-test key (`randomBytes(32).toString('base64')`).

## Layout

```
apps/api/tests/
├── global-setup.ts           # boots one MongoMemoryServer for the run
├── helpers/
│   ├── harness.ts            # startHarness() — connects to shared mongo + createApp
│   ├── fake-gmail.ts         # FakeGmailClient + buildPlainMessage helper
│   └── fake-calendar.ts      # FakeCalendarClient
├── fixtures/
│   └── gmail/                # (raw JSON fixtures slot, currently empty)
├── setup.ts                  # LOG_LEVEL=silent default
├── config.test.ts                  # loadConfig branches (zod parse, defaults, CSV transforms, KAO pairing)
├── duration.test.ts                # parseDurationMs (ISO + short forms)
├── kao-client.test.ts              # Kao token vend, cache, force=1 retry, error-taxonomy translation, fetchGrantStatus
├── google-client-self-heal.test.ts # Gmail/Calendar client 401 → force-refresh → retry-once contract
├── google-client-timeout.test.ts   # 30s AbortSignal.timeout wired through both clients
├── parse-message.test.ts           # parseGmailMessage + parseAddress[List] + senderDomain
├── parse-event.test.ts             # parseCalendarEvent (organizer dedup, all-day, cancelled)
├── upsert-person.test.ts           # find-or-create semantics; suppressReingest; un-tombstone
├── people-sort.test.ts             # lastInteractionAt:-1 cursor (null bucket)
├── digest.test.ts                  # /digest overdue/upcoming + duration parsing
├── contexts.test.ts                # /contexts aggregation + personId scoping
├── health.test.ts                  # /health + resource-route no-auth contract
├── kokoro-contract.test.ts         # read-only CRM API contract consumed by Kokoro
├── crud.test.ts                    # CRUD endpoints across people, organizations, interactions, followups
├── gmail-ingest.test.ts            # bootstrap + incremental + skip-self + newsletter + pause
├── gcal-ingest.test.ts             # bootstrap + incremental + 410 SyncTokenExpired + cancellation
└── logger.test.ts                  # stable service/component/env bindings on the @kagami/logger wrapper
```

## Harness

`apps/api/tests/helpers/harness.ts`:

```ts
export async function startHarness(): Promise<TestHarness> {
  const baseUri = process.env[SHARED_MONGO_URI_ENV];
  if (!baseUri) throw new Error(`${SHARED_MONGO_URI_ENV} not set — globalSetup must run first`);

  const dbName = `kizuna_test_${randomBytes(6).toString("hex")}`;
  const uri = baseUri.replace(/\/?$/, `/${dbName}`);

  const config = loadConfig({
    MONGODB_URI: uri,
    USER_EMAILS: "test@example.com",
    KAO_URL: "https://api.kao.localhost",
    KAO_TOKEN: "test-kao-bearer",
  });

  const db = await connectDb(config.MONGODB_URI);
  const app = createApp({ db, config });
  return {
    app,
    db,
    uri,
    stop: async () => {
      await db.conn.connection.dropDatabase();
      await db.close();
    },
  };
}
```

Per-file lifecycle:

```ts
let h: TestHarness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  await Promise.all([
    Person.deleteMany({}),
    Organization.deleteMany({}),
    Interaction.deleteMany({}),
    Followup.deleteMany({}),
  ]);
});
```

`fileParallelism: false` means files in the same run reuse the same Vitest worker, and `globalSetup` boots one `mongod` in the parent for the whole run. Each `startHarness()` call only opens a fresh database on that shared instance — startup is ~10 ms instead of the ~30 s container cold-boot it replaced.

## Patterns

### CRUD assertions over `supertest`

```ts
const post = (p: string, body?: object) => request(h.app).post(p).send(body);

it("creates a person with source=concierge and firstSeen set", async () => {
  const r = await post("/people", {
    displayName: "Sarah Connor",
    primaryEmail: "Sarah@Example.com",
  });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ source: "concierge", primaryEmail: "sarah@example.com" });
});
```

### Spying on Google clients

```ts
const spy = vi.spyOn(OAuth2Client.prototype, "getToken") as unknown as {
  mockResolvedValue: (v: unknown) => unknown;
};
spy.mockResolvedValue({
  tokens: {
    refresh_token: "1//refresh-fake",
    scope: "gmail.readonly calendar.readonly",
    expiry_date: Date.now() + 3_500_000,
  },
  res: null,
});
```

The dashboard never appears in tests. The OAuth callback is exercised by minting a valid signed state from `GET /oauth/google/start`, then issuing the callback request with a mocked `getToken`.

### Fake Google ingest clients

```ts
const client = new FakeGmailClient();
client.add(
  buildPlainMessage({
    id: "m1",
    from: "sarah@acme.com",
    to: "me@example.com",
    subject: "Hi",
    body: "Hello",
  }),
);
const result = await runGmailSync({ config, client });
expect(result.inserted).toBe(1);
```

The `runGmailSync({ config, client })` and `runCalendarSync({ config, client })` entry points exist precisely so tests can bypass the dynamic `await import('./gmail-client.js')` inside `runGmailSyncOnce`. The same workers run in production via the `*Once` shim that wires up the real client.

### Pause + resume

```ts
client.fail401AtMessageId = "m2";
const first = await runGmailSync({ config, client });
expect(first.status).toBe("paused");
const state = await SyncState.findOne({ provider: "gmail" });
expect(state?.pausedAt).toBeTruthy();

const forced = await runGmailSync({ config, client, force: true });
expect(forced.status).toBe("ok");
```

## Commands

```bash
npm run test                          # turbo run test (api only — dashboard has no test script)
cd apps/api && npm test               # vitest run, scoped to the api workspace
cd apps/api && npm run test:watch     # vitest watch
LOG_LEVEL=debug cd apps/api && npm test   # surface pino logs while triaging
```

The first run downloads a `mongod` binary into `mongodb-memory-server`'s cache (~150 MB, one time). Subsequent runs reuse it. The full suite runs in ~4 s on a warm cache; pure-helper tests (`config`, `duration`, `kao-client`, `google-client-*`, `parse-message`, `parse-event`, `logger`) skip the harness entirely and finish in milliseconds.

## What's covered

| Area                                           | Coverage                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `config.ts` env parsing                        | `config.test.ts` — defaults, CSV transforms, KAO_URL/KAO_TOKEN paired-or-neither rule                                 |
| `duration.ts` (ISO + short forms)              | `duration.test.ts`                                                                                                    |
| `kao-client.ts` (token vend + status)          | `kao-client.test.ts` — cache, `force=1` retry, error-taxonomy translation, `fetchGrantStatus` reshape                 |
| Gmail/Calendar client self-heal                | `google-client-self-heal.test.ts` — 401/403 → `getAccessToken({force:true})` → retry once; second 401 escapes         |
| Gmail/Calendar request timeout                 | `google-client-timeout.test.ts` — 30s AbortSignal.timeout wired through both clients                                  |
| `parse-message.ts` (Gmail parser)              | `parse-message.test.ts`                                                                                               |
| `parse-event.ts` (Calendar parser)             | `parse-event.test.ts`                                                                                                 |
| `upsertPerson` semantics                       | `upsert-person.test.ts` — find-or-create, suppressReingest, un-tombstone                                              |
| `/people` cursor + sort                        | `people-sort.test.ts` — `lastInteractionAt:-1` compound cursor + null bucket                                          |
| `/digest`                                      | `digest.test.ts`                                                                                                      |
| `/contexts`                                    | `contexts.test.ts`                                                                                                    |
| `/health` + resource-route no-auth contract    | `health.test.ts`                                                                                                      |
| CRUD across people/orgs/interactions/followups | `crud.test.ts`                                                                                                        |
| Gmail ingest end-to-end                        | `gmail-ingest.test.ts` — bootstrap, incremental, skip-self, newsletter blocklist, dedup via `sourceRef`, pause/resume |
| Calendar ingest end-to-end                     | `gcal-ingest.test.ts` — bootstrap, incremental, 410 → re-bootstrap, cancellation, edit reconciliation                 |
| Kokoro read-only API contract                  | `kokoro-contract.test.ts` — identity search and sorted interactions/followups                                         |
| Logger bindings                                | `logger.test.ts` — stable `service`/`component`/`env` on the `@kagami/logger` wrapper                                 |

## What's not covered

- **Dashboard.** No tests on `apps/dashboard/`. Server actions, server-component rendering, and the API client are all exercised manually for now. Revisit after the API surface stabilizes.
- **Scheduler timing.** `startIngestScheduler` is a thin `setInterval` wrapper and is not exercised. The wrapped `runGmailSync` / `runCalendarSync` are covered.
- **Concurrent-write races.** The unique partial index on `interactions.sourceRef` makes most ingest races safe at the DB level; tests don't currently assert "two parallel calls dedup correctly," but the index does the work. `upsertPerson`'s find-then-update window is also not stress-tested under concurrency.

## Adding a test

1. Pick the right harness shape:
   - Pure helper → top-level imports, no `startHarness`.
   - DB / HTTP → `beforeAll(startHarness)` + `afterAll(stop)` + `beforeEach(deleteMany)`.
2. Stub external calls — `vi.spyOn(globalThis, 'fetch')` for Kao token-vend tests, or inject a `FakeGmailClient` / `FakeCalendarClient` for ingest end-to-end tests.
3. Use `expect(r.body).toMatchObject(...)` for shape assertions; reserve `toEqual` for fully-known payloads.
4. When mutating `process.env`, use `vi.stubEnv` and `vi.unstubAllEnvs` in `afterEach` (the suite re-imports `loadConfig` fresh per call rather than relying on module re-evaluation, so this is rarely needed).
