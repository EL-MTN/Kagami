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

  it("does not require auth", async () => {
    const res = await request(h.app).get("/health").set("authorization", "");
    expect(res.status).toBe(200);
  });
});

describe("/v1/* auth", () => {
  it("rejects requests without a bearer token (401)", async () => {
    const res = await request(h.app).get("/v1/anything");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects requests with the wrong bearer token (401)", async () => {
    const res = await request(h.app)
      .get("/v1/anything")
      .set("authorization", "Bearer not-the-right-key");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("passes auth then 404 (no /v1 routes mounted yet)", async () => {
    const res = await request(h.app).get("/v1/anything").set("authorization", `Bearer ${h.apiKey}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
