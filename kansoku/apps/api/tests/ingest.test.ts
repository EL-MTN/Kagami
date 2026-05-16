import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

const TOKEN = "test-token-do-not-use-in-production";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  setupTestMongo("ingest");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes();
  const { createApp } = await import("../src/server.ts");
  const app = createApp({ ingestToken: TOKEN });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind to a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await teardownTestMongo();
});

// Wait for the fire-and-forget ingest write to land. The route returns 202
// before the Mongo insert finishes, so a poll lets the writer catch up
// without coupling the test to an arbitrary sleep.
async function waitForLogCount(min: number, timeoutMs = 5_000): Promise<number> {
  const { queryLogs } = await import("../src/storage/logs.ts");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await queryLogs({ limit: 100 });
    if (logs.length >= min) return logs.length;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`logs collection did not reach >= ${min} within ${timeoutMs}ms`);
}

function sampleEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: Date.now(),
    level: 30,
    service: "kioku-api",
    component: "api",
    env: "test",
    msg: "hello world",
    pid: 1234,
    hostname: "test-host",
    ...overrides,
  };
}

it("rejects requests without an auth token", async () => {
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([sampleEnvelope()]),
  });
  expect(res.status).toBe(401);
});

it("rejects requests with a wrong auth token", async () => {
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kansoku-auth": "wrong-token",
    },
    body: JSON.stringify([sampleEnvelope()]),
  });
  expect(res.status).toBe(401);
});

it("rejects malformed envelopes with 400", async () => {
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kansoku-auth": TOKEN,
    },
    body: JSON.stringify([
      { time: "not-a-number", level: 30, service: "x", component: "y", env: "z" },
    ]),
  });
  expect(res.status).toBe(400);
});

it("accepts a valid batch and persists it as a time-series doc", async () => {
  const envelope = sampleEnvelope({
    msg: "ingest round trip",
    traceId: "trace-abc",
    spanId: "span-1",
    userField: 42,
  });
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kansoku-auth": TOKEN,
    },
    body: JSON.stringify([envelope]),
  });
  expect(res.status).toBe(202);
  await expect(res.json()).resolves.toEqual({ accepted: 1 });

  await waitForLogCount(1);
  const { queryLogs } = await import("../src/storage/logs.ts");
  const logs = await queryLogs({ service: "kioku-api", limit: 10 });
  expect(logs).toHaveLength(1);
  const doc = logs[0]!;
  expect(doc.meta).toEqual({
    service: "kioku-api",
    component: "api",
    env: "test",
    level: "info",
  });
  expect(doc.msg).toBe("ingest round trip");
  expect(doc.traceId).toBe("trace-abc");
  expect(doc.spanId).toBe("span-1");
  expect(doc.fields).toMatchObject({ userField: 42, pid: 1234, hostname: "test-host" });
});

it("accepts the new wire format: ISO-8601 string time + string level", async () => {
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kansoku-auth": TOKEN },
    body: JSON.stringify([
      sampleEnvelope({
        time: new Date("2026-05-15T12:34:56.000Z").toISOString(),
        level: "warn",
        service: "iso-svc",
        msg: "iso line",
      }),
    ]),
  });
  expect(res.status).toBe(202);

  await waitForLogCount(1);
  const { queryLogs } = await import("../src/storage/logs.ts");
  const logs = await queryLogs({ service: "iso-svc" });
  expect(logs).toHaveLength(1);
  expect(logs[0]!.meta.level).toBe("warn");
  expect(logs[0]!.ts.toISOString()).toBe("2026-05-15T12:34:56.000Z");
});

it('collapses an unrecognized level to "unknown" rather than leaking cardinality', async () => {
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kansoku-auth": TOKEN },
    body: JSON.stringify([sampleEnvelope({ level: 99, service: "junk-level-svc" })]),
  });
  expect(res.status).toBe(202);

  await waitForLogCount(1);
  const { queryLogs } = await import("../src/storage/logs.ts");
  const logs = await queryLogs({ service: "junk-level-svc" });
  expect(logs).toHaveLength(1);
  expect(logs[0]!.meta.level).toBe("unknown");
});

it("rejects an over-long meta field with 400", async () => {
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kansoku-auth": TOKEN },
    body: JSON.stringify([sampleEnvelope({ component: "c".repeat(65) })]),
  });
  expect(res.status).toBe(400);
});

it("normalizes pino numeric levels to strings", async () => {
  const res = await fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kansoku-auth": TOKEN,
    },
    body: JSON.stringify([sampleEnvelope({ level: 50, msg: "boom", service: "level-test" })]),
  });
  expect(res.status).toBe(202);

  await waitForLogCount(1);
  const { queryLogs } = await import("../src/storage/logs.ts");
  const logs = await queryLogs({ service: "level-test", level: "error" });
  expect(logs).toHaveLength(1);
  expect(logs[0]!.meta.level).toBe("error");
});

it("ingest is fail-closed when the configured token is unset", async () => {
  const { createApp } = await import("../src/server.ts");
  const tokenlessApp = createApp({ ingestToken: undefined });
  const tokenlessServer = tokenlessApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => tokenlessServer.once("listening", resolve));
  try {
    const addr = tokenlessServer.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kansoku-auth": TOKEN },
      body: JSON.stringify([sampleEnvelope()]),
    });
    expect(res.status).toBe(503);
  } finally {
    await new Promise<void>((resolve, reject) => {
      tokenlessServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
