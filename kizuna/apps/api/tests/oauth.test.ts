import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { SyncState } from "../src/db/models/SyncState.js";
import { clearAccessTokenCache } from "../src/lib/kao-client.js";
import { startHarness, type TestHarness } from "./helpers/harness.js";

// Minimal route-level coverage for the Kao-backed OAuth surface. The legacy
// oauth.test.ts was deleted with the consent flow itself (which now lives in
// Kao), so this file covers what Kizuna still owns: the /start 302 to Kao,
// the prerequisite gates, the pause-cleanup side effect, and the
// /status reshape over Kao's grant payload.

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await SyncState.deleteMany({});
  clearAccessTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /oauth/google/start", () => {
  it("302s to Kao's per-grant consent URL when Kao is configured", async () => {
    const res = await request(h.app).get("/oauth/google/start").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://api.kao.localhost/oauth/kizuna/start");
  });

  it("returns 400 when Kao is not configured", async () => {
    const noKaoConfig = loadConfig({
      MONGODB_URI: h.uri,
      USER_EMAILS: "me@example.com",
    });
    const app = createApp({ db: h.db, config: noKaoConfig });
    const res = await request(app).get("/oauth/google/start").redirects(0);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Kao is not configured/);
  });

  it("clears pausedAt and lastError on paused workers before redirecting", async () => {
    await SyncState.create({
      provider: "gmail",
      pausedAt: new Date("2026-04-01T00:00:00Z"),
      lastError: "invalid_grant",
      lastRunAt: new Date(),
      errorCount: 3,
      historyId: null,
      source: "gmail-sync",
    });
    await SyncState.create({
      provider: "gcal",
      pausedAt: new Date("2026-04-01T00:00:00Z"),
      lastError: "invalid_grant",
      lastRunAt: new Date(),
      errorCount: 1,
      syncToken: null,
      source: "gcal-sync",
    });

    const res = await request(h.app).get("/oauth/google/start").redirects(0);
    expect(res.status).toBe(302);

    const gmail = await SyncState.findOne({ provider: "gmail" }).lean();
    const gcal = await SyncState.findOne({ provider: "gcal" }).lean();
    expect(gmail!.pausedAt).toBeNull();
    expect(gmail!.lastError).toBeNull();
    expect(gcal!.pausedAt).toBeNull();
    expect(gcal!.lastError).toBeNull();
    // errorCount is operator-visible signal; intentionally not reset.
    expect(gmail!.errorCount).toBe(3);
  });
});

describe("GET /oauth/google/status", () => {
  it("returns { granted: false } when Kao is not configured", async () => {
    const noKaoConfig = loadConfig({
      MONGODB_URI: h.uri,
      USER_EMAILS: "me@example.com",
    });
    const app = createApp({ db: h.db, config: noKaoConfig });
    const res = await request(app).get("/oauth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false });
  });

  it("reshapes Kao's granted=true response into the dashboard envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "kizuna",
          granted: true,
          scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/calendar.readonly",
          ],
          grantedAt: "2026-04-01T12:00:00.000Z",
          revokedAt: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      granted: true,
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
      grantedAt: "2026-04-01T12:00:00.000Z",
    });
  });

  it("collapses Kao 5xx to { granted: false } so the dashboard shows Connect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server error", { status: 503 }),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false });
  });

  it("collapses Kao network failure to { granted: false }", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false });
  });

  it("falls back to epoch grantedAt rather than dropping a granted Kao row", async () => {
    // Defensive: if Kao ever returns granted:true with grantedAt:null, the
    // grant works (tokens can be vended) so the dashboard should still see
    // it as granted. Epoch is a visible sentinel rather than a silent drop.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "kizuna",
          granted: true,
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          grantedAt: null,
          revokedAt: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.body.granted).toBe(true);
    expect(res.body.grantedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});
