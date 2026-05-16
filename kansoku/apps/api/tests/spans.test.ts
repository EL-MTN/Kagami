import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

const TOKEN = "test-token-do-not-use-in-production";
const TID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 32 hex — route validates

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  setupTestMongo("spans");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes();
  const { createApp } = await import("../src/server.ts");
  server = createApp({ ingestToken: TOKEN }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await teardownTestMongo();
});

function post(body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kansoku-auth": TOKEN },
    body: JSON.stringify(body),
  });
}

it("folds ECS span events into the spans collection and the trace view", async () => {
  const spanEvent = {
    "@timestamp": "2026-05-15T10:00:00.000Z",
    log: { level: "info" },
    service: { name: "svc-a", environment: "test", component: "api" },
    trace: { id: TID },
    span: { id: "1111111111111111", parent: { id: "2222222222222222" } },
    event: { kind: "span", name: "db.query", duration_ms: 12, status: "ok" },
    message: "span",
  };
  const plainLog = {
    "@timestamp": "2026-05-15T10:00:00.100Z",
    log: { level: "info" },
    service: { name: "svc-a", environment: "test", component: "api" },
    trace: { id: TID },
    span: { id: "1111111111111111" },
    message: "did a thing",
  };

  expect((await post([spanEvent, plainLog])).status).toBe(202);

  // recordSpans is fire-and-forget — poll the trace endpoint.
  const deadline = Date.now() + 5_000;
  let body: { logs: unknown[]; spans: Array<Record<string, unknown>> } = { logs: [], spans: [] };
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/v1/traces/${TID}`);
    body = (await res.json()) as typeof body;
    if (body.spans.length >= 1 && body.logs.length >= 2) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  // The span line is still a normal log (build-light: span events ARE logs).
  expect(body.logs.length).toBeGreaterThanOrEqual(2);
  expect(body.spans).toHaveLength(1);
  expect(body.spans[0]).toMatchObject({
    traceId: TID,
    spanId: "1111111111111111",
    parentSpanId: "2222222222222222",
    name: "db.query",
    service: "svc-a",
    component: "api",
    durationMs: 12,
    status: "ok",
  });
});

it("does not create span docs for ordinary log lines", async () => {
  const { extractSpan } = await import("../src/storage/spans.ts");
  expect(
    extractSpan({
      ts: new Date(),
      meta: { service: "s", component: "c", env: "test", level: "info" },
      msg: "hello",
      traceId: TID,
      spanId: "3333333333333333",
    }),
  ).toBeUndefined();
});
