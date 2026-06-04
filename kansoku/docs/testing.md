# Kansoku — Testing

Vitest + `mongodb-memory-server`. Config at
[`kansoku/vitest.config.ts`](../vitest.config.ts).

## Layout

```
apps/api/tests/
├── global-setup.ts            boots a single MongoMemoryReplSet for the suite
├── helpers/
│   ├── mongo.ts               per-suite isolated DB + closeMongo teardown
│   ├── quiescence.ts          quiesce() — poll until async ingest/egress settles
│   └── webhook-receiver.ts    startWebhookReceiver() — in-test HTTP sink for alerts
├── fingerprint.test.ts        pure-unit; no Mongo
├── tail.test.ts               SSE; no Mongo (uses publishLog directly)
├── cardinality.test.ts        metaField distinct-tuple budget guard; no Mongo
├── ingest.test.ts             ingest round trip; Mongo
├── ingest-durability.test.ts  write-then-ack, retry, 503 requeue (storage mocked)
├── indexes.test.ts            ensureIndexes; Mongo
├── spans.test.ts              span folding + /v1/traces/:id trace view; Mongo
└── alert-spike.test.ts        new-error + spike webhook semantics; Mongo
```

## Running

```bash
# From the Kagami workspace root
npx turbo run test --filter="@kansoku/*"

# Inside the Kansoku project
cd kansoku
npx vitest run                  # all suites
npx vitest run apps/api/tests/fingerprint.test.ts
npx vitest                      # watch mode
```

## Mongo harness

`apps/api/tests/global-setup.ts` boots a single `MongoMemoryReplSet`
once per suite and stashes its URI under `__KANSOKU_SHARED_MONGO_URI__`.
The boot is tolerant: when the binary download fails (offline sandbox,
stale OS image, etc.), the setup logs a warning and continues — so
Mongo-free suites (`fingerprint.test.ts`, `tail.test.ts`) still run.

Per-suite isolation lives in `helpers/mongo.ts`. Call `setupTestMongo(facet)`
in `beforeAll` (where `facet` is a short, unique name per test file) to
point the Kansoku Mongo singleton at a per-suite DB. Pair with
`teardownTestMongo` in `afterAll` so the next file picks up its own env on
next `getDb()` call.

## What's covered

| Surface                                                 | Covered by                  |
| ------------------------------------------------------- | --------------------------- |
| Time-series creation + indexes                          | `indexes.test.ts`           |
| `POST /v1/logs` auth + happy path + level normalization | `ingest.test.ts`            |
| Fingerprint extraction / normalizer / cause chains      | `fingerprint.test.ts`       |
| SSE delivery + filter + replay                          | `tail.test.ts`              |
| `recordErrors` upsert semantics (order/replay-safe)     | `alert-spike.test.ts`       |
| Alert webhook (new-error + spike + cooldown)            | `alert-spike.test.ts`       |
| Span folding + `/v1/traces/:id` trace view              | `spans.test.ts`             |
| Cardinality budget guard                                | `cardinality.test.ts`       |
| Ingest durability (write-then-ack, 503 requeue)         | `ingest-durability.test.ts` |
| `/v1/services` aggregations                             | not yet                     |

## Convention

When production behaves differently than a test expects, **fix the
service, not the test**. The same rule applies as in Kioku and Kizuna —
tests are the contract.

When the wire shape changes, update the envelope (`apps/api/src/lib/envelope.ts`)
_and_ every test that exercises it. The pino producer side lives in
`@kagami/logger`'s `kansoku-stream` — the wire format is a producer/consumer
contract; both sides need to move together.
