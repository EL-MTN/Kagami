import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, it } from "vitest";
import { newTraceContext, parseTraceparent, runWithTrace } from "../src/trace";
import { tracedFetch } from "../src/traced-fetch";

let server: Server;
let received: { traceparent: string | null } = { traceparent: null };
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.get("/echo", (req, res) => {
    received = { traceparent: req.header("traceparent") ?? null };
    res.json({ ok: true });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

it("passes through when there's no active trace context", async () => {
  received = { traceparent: null };
  await tracedFetch(`${baseUrl}/echo`);
  expect(received.traceparent).toBeNull();
});

it("propagates the active context as a traceparent header", async () => {
  received = { traceparent: null };
  const ctx = newTraceContext();
  await runWithTrace(ctx, () => tracedFetch(`${baseUrl}/echo`));
  expect(received.traceparent).not.toBeNull();
  const parsed = parseTraceparent(received.traceparent);
  expect(parsed?.traceId).toBe(ctx.traceId);
  expect(parsed?.spanId).toBe(ctx.spanId);
});

it("merges with caller-provided headers", async () => {
  received = { traceparent: null };
  const ctx = newTraceContext();
  await runWithTrace(ctx, () =>
    tracedFetch(`${baseUrl}/echo`, { headers: { "x-test": "marker" } }),
  );
  expect(received.traceparent).not.toBeNull();
});
