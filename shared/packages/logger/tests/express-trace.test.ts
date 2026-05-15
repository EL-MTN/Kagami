import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, it } from "vitest";
import { traceMiddleware } from "../src/express-trace";
import { getTraceContext, parseTraceparent } from "../src/trace";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(traceMiddleware());
  app.get("/ctx", (_req, res) => {
    const ctx = getTraceContext();
    res.json(ctx ?? null);
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  // Force-close any keep-alive sockets so the close callback fires fast.
  // Without this, Node's default http agent reuse can delay teardown
  // until its idle-socket timeout, occasionally flaking vitest's
  // "hanging process" report.
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

it("mints a fresh context when no traceparent is sent", async () => {
  const res = await fetch(`${baseUrl}/ctx`);
  expect(res.status).toBe(200);
  const ctx = (await res.json()) as { traceId: string; spanId: string } | null;
  expect(ctx).not.toBeNull();
  expect(ctx!.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(ctx!.spanId).toMatch(/^[0-9a-f]{16}$/);

  // Server should also echo a traceparent header pointing at the new span.
  const header = res.headers.get("traceparent");
  expect(header).not.toBeNull();
  const parsed = parseTraceparent(header);
  expect(parsed?.traceId).toBe(ctx!.traceId);
  expect(parsed?.spanId).toBe(ctx!.spanId);
});

it("opens a child span when traceparent is provided", async () => {
  const incoming = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
  const res = await fetch(`${baseUrl}/ctx`, { headers: { traceparent: incoming } });
  const ctx = (await res.json()) as {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
  expect(ctx.traceId).toBe("a".repeat(32));
  expect(ctx.parentSpanId).toBe("b".repeat(16));
  expect(ctx.spanId).not.toBe("b".repeat(16));
});

it("falls back to a fresh context on a malformed traceparent", async () => {
  const res = await fetch(`${baseUrl}/ctx`, { headers: { traceparent: "totally-bogus" } });
  const ctx = (await res.json()) as { traceId: string; parentSpanId?: string };
  expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(ctx.parentSpanId).toBeUndefined();
});
