import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPerMinuteRateLimit, parseRateLimitPerMinute } from "../src/routes/rate-limit.ts";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.post("/limited", createPerMinuteRateLimit("test-limit", 1), (_req, res) => {
    res.status(204).end();
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind to a port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

it("parseRateLimitPerMinute uses defaults and validates env overrides", () => {
  expect(parseRateLimitPerMinute("MISSING_RATE_LIMIT", 12, {})).toBe(12);
  expect(parseRateLimitPerMinute("CUSTOM_RATE_LIMIT", 12, { CUSTOM_RATE_LIMIT: "7" })).toBe(7);
  expect(() =>
    parseRateLimitPerMinute("CUSTOM_RATE_LIMIT", 12, { CUSTOM_RATE_LIMIT: "0" }),
  ).toThrow("CUSTOM_RATE_LIMIT must be a positive integer");
  expect(() =>
    parseRateLimitPerMinute("CUSTOM_RATE_LIMIT", 12, { CUSTOM_RATE_LIMIT: "abc" }),
  ).toThrow("CUSTOM_RATE_LIMIT must be a positive integer");
});

it("createPerMinuteRateLimit returns JSON 429 responses after the cap", async () => {
  const first = await fetch(`${baseUrl}/limited`, { method: "POST" });
  const second = await fetch(`${baseUrl}/limited`, { method: "POST" });

  expect(first.status).toBe(204);
  expect(second.status).toBe(429);
  await expect(second.json()).resolves.toEqual({
    error: "rate_limited",
    limit: 1,
    window_seconds: 60,
  });
});
