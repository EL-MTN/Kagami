import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";
import { quiesce } from "./helpers/quiescence.ts";
import { startWebhookReceiver, type WebhookReceiver } from "./helpers/webhook-receiver.ts";
import type { StoredLog } from "../src/storage/logs.ts";
import type { ErrorRecord } from "../src/storage/errors.ts";

// End-to-end test: real webhook receiver + direct calls to recordErrors
// with crafted StoredLog batches. The HTTP ingest path is covered by
// ingest.test.ts; this file targets recordErrors's control flow.

interface CapturedAlert {
  kind: string;
  fingerprint: string;
  body: Record<string, unknown>;
}

let receiver: WebhookReceiver;
const captured: CapturedAlert[] = [];

function makeLog(overrides: Partial<StoredLog> = {}): StoredLog {
  return {
    ts: new Date(),
    meta: { service: "kioku-api", component: "api", env: "test", level: "error" },
    msg: "boom",
    fields: {
      err: {
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'foo')",
        stack: "TypeError: Cannot read…\n    at handle (/app/src/ingest.ts:12:5)",
      },
    },
    ...overrides,
  };
}

beforeAll(async () => {
  setupTestMongo("alert-spike");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes();

  receiver = await startWebhookReceiver();
  // Mirror the helper's captured array into the test's typed view as
  // each request lands. Since the receiver pushes asynchronously, poll
  // via Object.defineProperty isn't worth it — just iterate from the
  // helper into `captured` in lockstep via a tiny adapter.
  // The simplest robust approach: replace the helper's push with our
  // own. But helper exposes the array; we wrap reads.
  // (Same array reference works because tests read captured.length.)

  vi.stubEnv("KANSOKU_ALERT_WEBHOOK_URL", receiver.url);
  vi.stubEnv("KANSOKU_SPIKE_THRESHOLD", "5");
  vi.stubEnv("KANSOKU_SPIKE_WINDOW_MINUTES", "5");
  vi.stubEnv("KANSOKU_SPIKE_COOLDOWN_MINUTES", "60");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await receiver.close();
  await teardownTestMongo();
});

beforeEach(() => {
  captured.length = 0;
  receiver.captured.length = 0;
});

// Drain any in-flight late arrivals before clearing the errors collection,
// then clear the collection so window/cooldown state doesn't leak across
// tests.
afterEach(async () => {
  await settleAlerts();
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection<ErrorRecord>("errors").deleteMany({});
});

// Adapter: project receiver.captured entries into the locally-typed
// `captured` array on every quiesce poll. Cheap; keeps test assertions
// reading from one place. Declared as a function so it's hoisted above
// the beforeAll / afterEach callbacks that reference it.
function syncCaptured(): void {
  while (captured.length < receiver.captured.length) {
    const body = receiver.captured[captured.length]!.body;
    captured.push({
      kind: String(body.kind),
      fingerprint: String(body.fingerprint),
      body,
    });
  }
}

async function waitAlerts(min: number, label?: string): Promise<void> {
  await quiesce({
    length: () => {
      syncCaptured();
      return captured.length;
    },
    min,
    label: label ?? "alerts",
  });
}

async function settleAlerts(): Promise<void> {
  await quiesce({
    length: () => {
      syncCaptured();
      return captured.length;
    },
    timeoutMs: 1_500,
    quietMs: 120,
    throwOnTimeout: false,
  });
}

describe("spike alerts", () => {
  it("fires a new-error alert on the first sighting of a fingerprint", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    await recordErrors([makeLog({ msg: "first-sighting-A", fields: undefined })]);
    await waitAlerts(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe("kansoku.error.new");
    expect(captured[0]!.body.message).toBe("first-sighting-A");
  });

  it("does not fire a spike alert below the threshold", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    for (let i = 0; i < 4; i += 1) {
      await recordErrors([makeLog({ msg: "below-threshold", fields: undefined })]);
    }
    await settleAlerts();
    const newAlerts = captured.filter((a) => a.kind === "kansoku.error.new");
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(newAlerts).toHaveLength(1);
    expect(spikes).toHaveLength(0);
  });

  it("fires exactly one spike alert when the threshold is crossed", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    // 6 errors total: 1 new-error (insert seeds windowCount=0) + 5 subsequent
    // errors increment to 5, hitting threshold and firing spike.
    for (let i = 0; i < 6; i += 1) {
      await recordErrors([makeLog({ msg: "spike-A", fields: undefined })]);
    }
    await waitAlerts(2);
    const newAlerts = captured.filter((a) => a.kind === "kansoku.error.new");
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(newAlerts).toHaveLength(1);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.body.count).toBe(5);
    expect(spikes[0]!.body.windowMinutes).toBe(5);
    expect(spikes[0]!.body.service).toBe("kioku-api");
  });

  it("suppresses additional spike alerts during the cooldown", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    for (let i = 0; i < 20; i += 1) {
      await recordErrors([makeLog({ msg: "spike-B", fields: undefined })]);
    }
    await waitAlerts(2);
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(spikes).toHaveLength(1);
  });

  it("re-fires after the cooldown expires (simulated via lastSpikeAlertAt rewind)", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const { fingerprintErrorLog } = await import("../src/lib/fingerprint.ts");
    const { getDb } = await import("../src/storage/mongo.ts");

    // Seed (insert + 5 evals) to fire spike.
    for (let i = 0; i < 6; i += 1) {
      await recordErrors([makeLog({ msg: "spike-C", fields: undefined })]);
    }
    await waitAlerts(2);
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(1);

    const fp = fingerprintErrorLog(makeLog({ msg: "spike-C", fields: undefined }));
    if (!fp) throw new Error("could not fingerprint test log");
    const db = await getDb();
    await db.collection<ErrorRecord>("errors").updateOne(
      { _id: fp.fingerprint },
      {
        $set: {
          lastSpikeAlertAt: new Date(Date.now() - 90 * 60_000),
          windowStart: new Date(Date.now() - 90 * 60_000),
          windowCount: 0,
        },
      },
    );

    captured.length = 0;
    receiver.captured.length = 0;
    for (let i = 0; i < 5; i += 1) {
      await recordErrors([makeLog({ msg: "spike-C", fields: undefined })]);
    }
    await waitAlerts(1);
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.body.count).toBe(5);
  });

  it("rolls the window when the window age exceeds windowMinutes", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const { fingerprintErrorLog } = await import("../src/lib/fingerprint.ts");
    const { getDb } = await import("../src/storage/mongo.ts");

    for (let i = 0; i < 3; i += 1) {
      await recordErrors([makeLog({ msg: "spike-D", fields: undefined })]);
    }
    await waitAlerts(1);
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);

    const fp = fingerprintErrorLog(makeLog({ msg: "spike-D", fields: undefined }));
    if (!fp) throw new Error("could not fingerprint test log");
    const db = await getDb();
    await db
      .collection<ErrorRecord>("errors")
      .updateOne(
        { _id: fp.fingerprint },
        { $set: { windowStart: new Date(Date.now() - 10 * 60_000) } },
      );

    captured.length = 0;
    receiver.captured.length = 0;
    for (let i = 0; i < 4; i += 1) {
      await recordErrors([makeLog({ msg: "spike-D", fields: undefined })]);
    }
    await settleAlerts();
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);

    const doc = await db.collection<ErrorRecord>("errors").findOne({ _id: fp.fingerprint });
    expect(doc?.windowCount).toBe(4);
  });

  it("does not fire alerts when KANSOKU_ALERT_WEBHOOK_URL is unset", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    vi.stubEnv("KANSOKU_ALERT_WEBHOOK_URL", "");
    try {
      for (let i = 0; i < 6; i += 1) {
        await recordErrors([makeLog({ msg: "spike-E", fields: undefined })]);
      }
      await settleAlerts();
      expect(captured).toHaveLength(0);
    } finally {
      vi.stubEnv("KANSOKU_ALERT_WEBHOOK_URL", receiver.url);
    }
  });

  it("skips the spike eval when ALL docs in the batch are older than the window (replay)", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    await recordErrors([makeLog({ msg: "spike-F", fields: undefined })]);
    await waitAlerts(1);

    captured.length = 0;
    receiver.captured.length = 0;
    const oldTs = new Date(Date.now() - 60 * 60_000);
    const replay: StoredLog[] = Array.from({ length: 20 }, () =>
      makeLog({ msg: "spike-F", ts: oldTs, fields: undefined }),
    );
    await recordErrors(replay);
    await settleAlerts();
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);
  });

  it("counts only in-window docs toward the spike increment (mixed-batch)", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const { fingerprintErrorLog } = await import("../src/lib/fingerprint.ts");
    const { getDb } = await import("../src/storage/mongo.ts");

    // Seed the fingerprint.
    await recordErrors([makeLog({ msg: "spike-mixed", fields: undefined })]);
    await waitAlerts(1);

    captured.length = 0;
    receiver.captured.length = 0;
    // 4 stale + 3 fresh = batch of 7. Only the 3 fresh contribute to
    // windowCount; threshold is 5, so no spike should fire.
    const oldTs = new Date(Date.now() - 60 * 60_000);
    const batch: StoredLog[] = [
      ...Array.from({ length: 4 }, () =>
        makeLog({ msg: "spike-mixed", ts: oldTs, fields: undefined }),
      ),
      ...Array.from({ length: 3 }, () => makeLog({ msg: "spike-mixed", fields: undefined })),
    ];
    await recordErrors(batch);
    await settleAlerts();
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);

    // Storage still records all 7 — count = 1 (seed) + 7 (batch) = 8.
    const fp = fingerprintErrorLog(makeLog({ msg: "spike-mixed", fields: undefined }));
    const db = await getDb();
    const doc = await db.collection<ErrorRecord>("errors").findOne({ _id: fp!.fingerprint });
    expect(doc?.count).toBe(8);
    // windowCount captures the 3 in-window docs (the seed was a separate
    // batch that took the insert path, so its eval didn't run).
    expect(doc?.windowCount).toBe(3);
  });

  it("does not fire a spike on a brand-new fingerprint even with threshold+ logs in one batch", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const batch: StoredLog[] = Array.from({ length: 20 }, () =>
      makeLog({ msg: "spike-G", fields: undefined }),
    );
    await recordErrors(batch);
    await waitAlerts(1);
    expect(captured.filter((a) => a.kind === "kansoku.error.new")).toHaveLength(1);
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);
  });

  it("does NOT fire spike when first batch is brand-new and only 1 more error arrives (phantom-backlog fix)", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    // Brand-new fingerprint batch of 200 — seeds windowCount=0 (per fix).
    const burst: StoredLog[] = Array.from({ length: 200 }, () =>
      makeLog({ msg: "phantom-backlog", fields: undefined }),
    );
    await recordErrors(burst);
    await waitAlerts(1);
    expect(captured.filter((a) => a.kind === "kansoku.error.new")).toHaveLength(1);

    captured.length = 0;
    receiver.captured.length = 0;
    // ONE more error of the same fingerprint. Window is fresh; windowCount
    // = 0 (seed) + 1 = 1. Threshold = 5 — NO spike should fire.
    await recordErrors([makeLog({ msg: "phantom-backlog", fields: undefined })]);
    await settleAlerts();
    expect(captured).toHaveLength(0);
  });

  it("fires exactly one spike for a single-batch burst on an existing fingerprint", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    await recordErrors([makeLog({ msg: "spike-H", fields: undefined })]);
    await waitAlerts(1);

    captured.length = 0;
    receiver.captured.length = 0;
    const burst: StoredLog[] = Array.from({ length: 100 }, () =>
      makeLog({ msg: "spike-H", fields: undefined }),
    );
    await recordErrors(burst);
    await waitAlerts(1);
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.body.count).toBe(100);
  });

  it("keeps lastSeen monotonic via $max even when a replay batch arrives with older ts", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const { fingerprintErrorLog } = await import("../src/lib/fingerprint.ts");
    const { getDb } = await import("../src/storage/mongo.ts");

    const liveTs = new Date();
    await recordErrors([makeLog({ msg: "monotone", ts: liveTs, fields: undefined })]);
    await waitAlerts(1);

    const fp = fingerprintErrorLog(makeLog({ msg: "monotone", fields: undefined }));
    const db = await getDb();
    const before = await db.collection<ErrorRecord>("errors").findOne({ _id: fp!.fingerprint });
    const liveLastSeen = before?.lastSeen?.getTime();
    expect(liveLastSeen).toBe(liveTs.getTime());

    // Replay an older batch — lastSeen must NOT regress.
    const oldTs = new Date(liveTs.getTime() - 60 * 60_000);
    await recordErrors([
      makeLog({ msg: "monotone", ts: oldTs, fields: undefined }),
      makeLog({ msg: "monotone", ts: oldTs, fields: undefined }),
    ]);
    await settleAlerts();

    const after = await db.collection<ErrorRecord>("errors").findOne({ _id: fp!.fingerprint });
    expect(after?.lastSeen?.getTime()).toBe(liveLastSeen);
    // count still increments — storage records the replay faithfully.
    expect(after?.count).toBe(3);
  });

  it("uses min/max for firstSeen/lastSeen on out-of-order batches", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const { fingerprintErrorLog } = await import("../src/lib/fingerprint.ts");
    const { getDb } = await import("../src/storage/mongo.ts");

    const t1 = new Date(Date.now() - 10_000);
    const t2 = new Date(Date.now() - 5_000);
    const t3 = new Date();
    // Arrive in [middle, latest, earliest] order — the doc should still
    // anchor firstSeen=t1 and lastSeen=t3.
    await recordErrors([
      makeLog({ msg: "unordered", ts: t2, fields: undefined }),
      makeLog({ msg: "unordered", ts: t3, fields: undefined }),
      makeLog({ msg: "unordered", ts: t1, fields: undefined }),
    ]);
    await waitAlerts(1);

    const fp = fingerprintErrorLog(makeLog({ msg: "unordered", fields: undefined }));
    const db = await getDb();
    const doc = await db.collection<ErrorRecord>("errors").findOne({ _id: fp!.fingerprint });
    expect(doc?.firstSeen?.getTime()).toBe(t1.getTime());
    expect(doc?.lastSeen?.getTime()).toBe(t3.getTime());
  });

  it("rejects KANSOKU_SPIKE_THRESHOLD=1 and falls back to the default", async () => {
    vi.stubEnv("KANSOKU_SPIKE_THRESHOLD", "1");
    try {
      const { getSpikeConfig } = await import("../src/lib/alerts.ts");
      const cfg = getSpikeConfig();
      expect(cfg.threshold).toBe(10);
    } finally {
      vi.stubEnv("KANSOKU_SPIKE_THRESHOLD", "5");
    }
  });
});
