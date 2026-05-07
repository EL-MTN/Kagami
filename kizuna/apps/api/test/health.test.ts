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

describe("/v1/* (no auth at single-user localhost)", () => {
  it("404s an unknown /v1 route", async () => {
    const res = await request(h.app).get("/v1/anything");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
