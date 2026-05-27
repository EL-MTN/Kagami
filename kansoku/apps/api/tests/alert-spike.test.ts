import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";
import type { StoredLog } from "../src/storage/logs.ts";
import type { ErrorRecord } from "../src/storage/errors.ts";

// End-to-end test: spin up a real webhook receiver, point Kansoku at it,
// then call recordErrors directly with crafted StoredLog batches. We hit
// recordErrors instead of the HTTP /v1/logs route to keep the test focused
// on the spike-detection control flow — the ingest-path wiring is already
// covered by ingest.test.ts.

interface CapturedAlert {
  kind: string;
  fingerprint: string;
  body: Record<string, unknown>;
}

let webhookServer: Server;
let webhookUrl: string;
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

// Wait until `captured` has at least `min` alerts AND no new alerts have
// arrived in the last `quietMs`. The recordErrors call resolves before its
// fire-and-forget `void postAlert(...)` chain lands, so a naïve "polled
// length >= min" returns too early and lets late arrivals leak into the
// next test's `captured`. Quiescence makes the wait robust.
async function waitForAlerts(min: number, timeoutMs = 3_000, quietMs = 80): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastChange = Date.now();
  let lastLength = captured.length;
  while (Date.now() < deadline) {
    if (captured.length !== lastLength) {
      lastLength = captured.length;
      lastChange = Date.now();
    }
    if (captured.length >= min && Date.now() - lastChange >= quietMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `expected at least ${min} alert(s) within ${timeoutMs}ms; got ${captured.length}`,
  );
}

// Wait for the in-flight fire-and-forget POSTs from the previous call to
// drain, even if the test expects zero alerts (so a late arrival can't
// pollute the next test).
async function settle(quietMs = 120): Promise<void> {
  let lastLength = captured.length;
  let lastChange = Date.now();
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (captured.length !== lastLength) {
      lastLength = captured.length;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= quietMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  setupTestMongo("alert-spike");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes();

  await new Promise<void>((resolve) => {
    webhookServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          captured.push({
            kind: String(parsed.kind),
            fingerprint: String(parsed.fingerprint),
            body: parsed,
          });
        } catch {
          // ignore malformed bodies — tests assert on `captured`
        }
        res.statusCode = 204;
        res.end();
      });
    });
    webhookServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = webhookServer.address();
  if (!addr || typeof addr === "string") throw new Error("webhook server did not bind");
  webhookUrl = `http://127.0.0.1:${addr.port}/`;
  // vi.stubEnv auto-unstubs in afterAll (via `unstubEnvs: true` if
  // configured, otherwise via the explicit call below) — strictly safer
  // than direct process.env mutation under any future pool/isolation
  // change. Tests within this file still see the stubbed values via
  // process.env reads (vitest forwards both).
  vi.stubEnv("KANSOKU_ALERT_WEBHOOK_URL", webhookUrl);
  vi.stubEnv("KANSOKU_SPIKE_THRESHOLD", "5");
  vi.stubEnv("KANSOKU_SPIKE_WINDOW_MINUTES", "5");
  vi.stubEnv("KANSOKU_SPIKE_COOLDOWN_MINUTES", "60");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => {
    webhookServer.close((err) => (err ? reject(err) : resolve()));
  });
  await teardownTestMongo();
});

beforeEach(() => {
  captured.length = 0;
});

// Drain any in-flight late arrivals before clearing the errors collection,
// then clear the collection so window/cooldown state doesn't leak across
// tests.
afterEach(async () => {
  await settle();
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection<ErrorRecord>("errors").deleteMany({});
});

describe("spike alerts", () => {
  it("fires a new-error alert on the first sighting of a fingerprint", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    await recordErrors([makeLog({ msg: "first-sighting-A", fields: undefined })]);
    await waitForAlerts(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe("kansoku.error.new");
    expect(captured[0]!.body.message).toBe("first-sighting-A");
  });

  it("does not fire a spike alert below the threshold", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    // Threshold is 5 — emit 4 to confirm no spike fires.
    for (let i = 0; i < 4; i += 1) {
      await recordErrors([makeLog({ msg: "below-threshold", fields: undefined })]);
    }
    await settle();
    const newAlerts = captured.filter((a) => a.kind === "kansoku.error.new");
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(newAlerts).toHaveLength(1);
    expect(spikes).toHaveLength(0);
  });

  it("fires exactly one spike alert when the threshold is crossed", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    // 5 errors → 1 new-error + 1 spike (windowCount reaches 5 on the 5th).
    for (let i = 0; i < 5; i += 1) {
      await recordErrors([makeLog({ msg: "spike-A", fields: undefined })]);
    }
    await waitForAlerts(2);
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
    // Cross the threshold, then keep emitting — only one spike alert.
    for (let i = 0; i < 20; i += 1) {
      await recordErrors([makeLog({ msg: "spike-B", fields: undefined })]);
    }
    await waitForAlerts(2);
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.body.count).toBe(5);
  });

  it("re-fires after the cooldown expires (simulated via lastSpikeAlertAt rewind)", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const { fingerprintErrorLog } = await import("../src/lib/fingerprint.ts");
    const { getDb } = await import("../src/storage/mongo.ts");

    // 5 errors → 1 new + 1 spike, threshold-locked into cooldown.
    for (let i = 0; i < 5; i += 1) {
      await recordErrors([makeLog({ msg: "spike-C", fields: undefined })]);
    }
    await waitForAlerts(2);
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
    for (let i = 0; i < 5; i += 1) {
      await recordErrors([makeLog({ msg: "spike-C", fields: undefined })]);
    }
    await waitForAlerts(1);
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
    await waitForAlerts(1);
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);

    const fp = fingerprintErrorLog(makeLog({ msg: "spike-D", fields: undefined }));
    if (!fp) throw new Error("could not fingerprint test log");
    const db = await getDb();
    // Age the window past windowMinutes — next eval should reset count to
    // 1, not continue from 3.
    await db
      .collection<ErrorRecord>("errors")
      .updateOne(
        { _id: fp.fingerprint },
        { $set: { windowStart: new Date(Date.now() - 10 * 60_000) } },
      );

    captured.length = 0;
    for (let i = 0; i < 4; i += 1) {
      await recordErrors([makeLog({ msg: "spike-D", fields: undefined })]);
    }
    await settle();
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);

    const doc = await db.collection<ErrorRecord>("errors").findOne({ _id: fp.fingerprint });
    expect(doc?.windowCount).toBe(4);
  });

  it("does not fire alerts when KANSOKU_ALERT_WEBHOOK_URL is unset", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    vi.stubEnv("KANSOKU_ALERT_WEBHOOK_URL", "");
    try {
      for (let i = 0; i < 5; i += 1) {
        await recordErrors([makeLog({ msg: "spike-E", fields: undefined })]);
      }
      await settle();
      expect(captured).toHaveLength(0);
    } finally {
      vi.stubEnv("KANSOKU_ALERT_WEBHOOK_URL", webhookUrl);
    }
  });

  it("skips the spike eval when the log's ts is older than the window (replay)", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    // Seed the fingerprint via a real-time first sighting so the new-error
    // alert fires once.
    await recordErrors([makeLog({ msg: "spike-F", fields: undefined })]);
    await waitForAlerts(1);

    captured.length = 0;
    // Replay 20 errors with a stale ts (older than the 5-min window).
    const oldTs = new Date(Date.now() - 60 * 60_000);
    const replay: StoredLog[] = Array.from({ length: 20 }, () =>
      makeLog({ msg: "spike-F", ts: oldTs, fields: undefined }),
    );
    await recordErrors(replay);
    await settle();
    // Replay guard should suppress the spike alert despite hitting the
    // threshold count.
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);
  });

  it("does not fire a spike on a brand-new fingerprint even when the batch contains threshold+ logs", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    // Batch of 20 identical brand-new errors. Grouping folds them into one
    // upsert: new-error fires once, spike does NOT fire (per design — a
    // fingerprint we just learned about can't be "spiking" against its
    // own absent history).
    const batch: StoredLog[] = Array.from({ length: 20 }, () =>
      makeLog({ msg: "spike-G", fields: undefined }),
    );
    await recordErrors(batch);
    await waitForAlerts(1);
    const newAlerts = captured.filter((a) => a.kind === "kansoku.error.new");
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(newAlerts).toHaveLength(1);
    expect(spikes).toHaveLength(0);
  });

  it("fires exactly one spike for a single-batch burst on an existing fingerprint", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    // Seed the fingerprint with a single real-time error so subsequent
    // batches take the existing-fingerprint path.
    await recordErrors([makeLog({ msg: "spike-H", fields: undefined })]);
    await waitForAlerts(1);

    captured.length = 0;
    // One batch of 100 identical errors — grouping folds them to one
    // updateOne + one evaluateSpike. Exactly one spike payload should
    // land; the cooldown gate guarantees at-most-one even under
    // concurrent calls to evaluateSpike inside the batch.
    const burst: StoredLog[] = Array.from({ length: 100 }, () =>
      makeLog({ msg: "spike-H", fields: undefined }),
    );
    await recordErrors(burst);
    await waitForAlerts(1);
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(spikes).toHaveLength(1);
    // count reflects the full burst (101 = 1 seed + 100 batch).
    expect(spikes[0]!.body.count).toBe(101);
  });

  it("rejects KANSOKU_SPIKE_THRESHOLD=1 and falls back to the default", async () => {
    // The floor of 2 in the env parser keeps threshold=1 unreachable
    // (which would otherwise be a no-op edge case since the first
    // sighting always takes the new-error path).
    vi.stubEnv("KANSOKU_SPIKE_THRESHOLD", "1");
    try {
      const { getSpikeConfig } = await import("../src/lib/alerts.ts");
      const cfg = getSpikeConfig();
      // Default is 10; threshold=1 should NOT take effect.
      expect(cfg.threshold).toBe(10);
    } finally {
      vi.stubEnv("KANSOKU_SPIKE_THRESHOLD", "5");
    }
  });
});
