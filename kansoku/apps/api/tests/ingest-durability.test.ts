import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

// Durability path is isolated from Mongo: the storage layer is mocked so we
// can drive the write outcome directly. ingest now write-then-acks — a
// persistent write failure must surface as 503 so the shipper requeues
// (the producer-side durable buffer) instead of the old fire-and-forget
// path that lost the batch silently during a Mongo outage.

vi.mock("../src/storage/logs.ts", () => ({
  insertLogs: vi.fn(),
  queryLogs: vi.fn().mockResolvedValue([]),
  queryTrace: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/storage/errors.ts", () => ({
  recordErrors: vi.fn().mockResolvedValue(undefined),
  listErrors: vi.fn().mockResolvedValue([]),
}));

const TOKEN = "test-token-do-not-use-in-production";

let server: Server;
let baseUrl: string;
let insertLogs: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const logs = await import("../src/storage/logs.ts");
  insertLogs = logs.insertLogs as unknown as ReturnType<typeof vi.fn>;
  const { createApp } = await import("../src/server.ts");
  const app = createApp({ ingestToken: TOKEN });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

afterEach(() => insertLogs.mockReset());

function post(): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kansoku-auth": TOKEN },
    body: JSON.stringify([
      { time: Date.now(), level: 30, service: "d", component: "c", env: "test", msg: "m" },
    ]),
  });
}

it("acks 202 with the inserted count once the write succeeds", async () => {
  insertLogs.mockResolvedValue({ insertedCount: 1, failedCount: 0, sampleErrors: [] });
  const res = await post();
  expect(res.status).toBe(202);
  await expect(res.json()).resolves.toEqual({ accepted: 1 });
  expect(insertLogs).toHaveBeenCalledTimes(1);
});

it("retries a transient write failure, then acks", async () => {
  insertLogs
    .mockRejectedValueOnce(new Error("transient"))
    .mockResolvedValue({ insertedCount: 1, failedCount: 0, sampleErrors: [] });
  const res = await post();
  expect(res.status).toBe(202);
  expect(insertLogs).toHaveBeenCalledTimes(2);
});

it("returns 503 after exhausting retries so the shipper requeues", async () => {
  insertLogs.mockRejectedValue(new Error("Mongo down"));
  const res = await post();
  expect(res.status).toBe(503);
  await expect(res.json()).resolves.toEqual({ error: "ingest_write_failed" });
  expect(insertLogs).toHaveBeenCalledTimes(3); // MAX_WRITE_ATTEMPTS
});
