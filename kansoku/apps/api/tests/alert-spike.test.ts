import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
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

async function waitForAlerts(min: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captured.length >= min) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `expected at least ${min} alert(s) within ${timeoutMs}ms; got ${captured.length}`,
  );
}

// `recordErrors` fires alerts via `void notify*(...)` — the call resolves
// before the webhook POST lands. Drain by waiting one event-loop tick plus
// a short settle for the fetch round trip to the in-process server.
async function settle(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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
  process.env.KANSOKU_ALERT_WEBHOOK_URL = webhookUrl;
  process.env.KANSOKU_SPIKE_THRESHOLD = "5";
  process.env.KANSOKU_SPIKE_WINDOW_MINUTES = "5";
  process.env.KANSOKU_SPIKE_COOLDOWN_MINUTES = "60";
});

afterAll(async () => {
  delete process.env.KANSOKU_ALERT_WEBHOOK_URL;
  delete process.env.KANSOKU_SPIKE_THRESHOLD;
  delete process.env.KANSOKU_SPIKE_WINDOW_MINUTES;
  delete process.env.KANSOKU_SPIKE_COOLDOWN_MINUTES;
  await new Promise<void>((resolve, reject) => {
    webhookServer.close((err) => (err ? reject(err) : resolve()));
  });
  await teardownTestMongo();
});

beforeEach(() => {
  captured.length = 0;
});

// Reset the errors collection between tests so window/cooldown state
// doesn't leak across cases. Each test stages its own fingerprint via
// distinct msgs anyway, but a clean slate makes assertions deterministic.
afterEach(async () => {
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
    await settle();
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
    await settle(200);
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
    // Rewind lastSpikeAlertAt past the 60-min cooldown.
    await db
      .collection<ErrorRecord>("errors")
      .updateOne(
        { _id: fp.fingerprint },
        { $set: { lastSpikeAlertAt: new Date(Date.now() - 90 * 60_000) } },
      );
    // Also collapse the existing window so the next batch re-rolls a
    // fresh window (otherwise it would still be inside the previous one
    // and immediately re-trip without exercising the post-cooldown path).
    await db
      .collection<ErrorRecord>("errors")
      .updateOne(
        { _id: fp.fingerprint },
        { $set: { windowStart: new Date(Date.now() - 90 * 60_000), windowCount: 0 } },
      );

    captured.length = 0;
    // 5 more errors → new window, hits threshold, fires once more.
    for (let i = 0; i < 5; i += 1) {
      await recordErrors([makeLog({ msg: "spike-C", fields: undefined })]);
    }
    await waitForAlerts(1);
    await settle();
    const spikes = captured.filter((a) => a.kind === "kansoku.error.spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.body.count).toBe(5);
  });

  it("rolls the window when the window age exceeds windowMinutes", async () => {
    const { recordErrors } = await import("../src/storage/errors.ts");
    const { fingerprintErrorLog } = await import("../src/lib/fingerprint.ts");
    const { getDb } = await import("../src/storage/mongo.ts");

    // Below-threshold burst: 3 errors → new + windowCount = 3.
    for (let i = 0; i < 3; i += 1) {
      await recordErrors([makeLog({ msg: "spike-D", fields: undefined })]);
    }
    await waitForAlerts(1);
    await settle();
    expect(captured.filter((a) => a.kind === "kansoku.error.spike")).toHaveLength(0);

    const fp = fingerprintErrorLog(makeLog({ msg: "spike-D", fields: undefined }));
    if (!fp) throw new Error("could not fingerprint test log");
    const db = await getDb();
    // Age the window past the 5-minute window — next eval should reset
    // count to 1, *not* continue from 3.
    await db
      .collection<ErrorRecord>("errors")
      .updateOne(
        { _id: fp.fingerprint },
        { $set: { windowStart: new Date(Date.now() - 10 * 60_000) } },
      );

    captured.length = 0;
    // 4 more errors. If the window reset, count goes 1→4 (no spike).
    // If the window had NOT reset, count would be 4→7 and fire on #2.
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
    const prev = process.env.KANSOKU_ALERT_WEBHOOK_URL;
    delete process.env.KANSOKU_ALERT_WEBHOOK_URL;
    try {
      for (let i = 0; i < 5; i += 1) {
        await recordErrors([makeLog({ msg: "spike-E", fields: undefined })]);
      }
      await settle();
      expect(captured).toHaveLength(0);
    } finally {
      process.env.KANSOKU_ALERT_WEBHOOK_URL = prev;
    }
  });
});
