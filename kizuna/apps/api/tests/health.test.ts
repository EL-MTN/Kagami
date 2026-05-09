import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startHarness, type TestHarness } from "./helpers/harness.js";

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

describe("GET /health", () => {
  it("returns 200 with db: up when Mongo is reachable", async () => {
    const res = await request(h.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: "up", service: "kizuna-api" });
    expect(typeof res.body.time).toBe("string");
  });
});

describe("resource routes (no auth at single-user localhost)", () => {
  it("404s an unknown resource route", async () => {
    const res = await request(h.app).get("/anything");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
