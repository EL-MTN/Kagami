import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { SyncState } from "../src/db/models/SyncState.js";
import { clearAccessTokenCache } from "../src/lib/kao-client.js";
import { startHarness, type TestHarness } from "./helpers/harness.js";

// Route-level coverage for the Kao-backed OAuth surface. The legacy
// oauth.test.ts was deleted with the consent flow itself (which now lives
// in Kao), so this file covers what Kizuna still owns:
//   * POST /oauth/google/start — 303 to Kao, prerequisite gates,
//     pause/errorCount-cleanup side effect, lastError preservation,
//     resilience to a transient SyncState write failure.
//   * GET /oauth/google/status — reshape over Kao's grant payload.

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

describe("POST /oauth/google/start", () => {
  it("303s to Kao's per-grant consent URL when Kao is configured", async () => {
    const res = await request(h.app).post("/oauth/google/start").redirects(0);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("https://api.kao.localhost/oauth/kizuna/start");
  });

  it("rejects GET (state-mutating routes must not be reachable by preloaders/<img> tags)", async () => {
    const res = await request(h.app).get("/oauth/google/start");
    // Express returns 404 for unmatched methods on a registered path.
    expect(res.status).toBe(404);
  });

  it("returns 400 when Kao is not configured", async () => {
    const noKaoConfig = loadConfig({
      MONGODB_URI: h.uri,
      USER_EMAILS: "me@example.com",
    });
    const app = createApp({ db: h.db, config: noKaoConfig });
    const res = await request(app).post("/oauth/google/start").redirects(0);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Kao is not configured/);
  });

  it("clears pausedAt and resets errorCount but leaves lastError intact", async () => {
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

    const res = await request(h.app).post("/oauth/google/start").redirects(0);
    expect(res.status).toBe(303);

    const gmail = await SyncState.findOne({ provider: "gmail" }).lean();
    const gcal = await SyncState.findOne({ provider: "gcal" }).lean();
    expect(gmail!.pausedAt).toBeNull();
    expect(gcal!.pausedAt).toBeNull();
    // errorCount reset so the dashboard doesn't show a perpetual "N errors"
    // badge after the worker recovers.
    expect(gmail!.errorCount).toBe(0);
    expect(gcal!.errorCount).toBe(0);
    // lastError preserved — recordSuccessfulRun clears it on a real success;
    // wiping it preemptively would erase the operator's diagnostic history.
    expect(gmail!.lastError).toBe("invalid_grant");
    expect(gcal!.lastError).toBe("invalid_grant");
  });

  it("accepts the dashboard's Origin header", async () => {
    const res = await request(h.app)
      .post("/oauth/google/start")
      .set("Origin", "https://kizuna.localhost")
      .redirects(0);
    expect(res.status).toBe(303);
  });

  it("rejects a cross-origin form POST from an unallowed Origin (CSRF defense)", async () => {
    // A malicious page on another origin issuing a form POST would send
    // its own Origin header; reject those rather than mutating SyncState.
    const res = await request(h.app)
      .post("/oauth/google/start")
      .set("Origin", "https://evil.example.com")
      .redirects(0);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/origin/i);
  });

  it("allows requests with no Origin header (curl / supertest)", async () => {
    // Programmatic callers don't send Origin; trusted on localhost-only.
    const res = await request(h.app).post("/oauth/google/start").redirects(0);
    expect(res.status).toBe(303);
  });

  it("still redirects to Kao even if the SyncState write fails (transient DB)", async () => {
    // Simulate a transient DB blip on the updateMany call by stubbing it
    // to throw. The redirect must still fire so the operator can complete
    // the consent flow; the next ingest tick will simply re-pause on the
    // same invalid_grant if Kao didn't take.
    vi.spyOn(SyncState, "updateMany").mockRejectedValueOnce(new Error("connection refused"));
    const res = await request(h.app).post("/oauth/google/start").redirects(0);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("https://api.kao.localhost/oauth/kizuna/start");
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

  it("collapses Kao 200 + {granted:false} to {granted:false}", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "kizuna",
          granted: false,
          scopes: [],
          grantedAt: null,
          revokedAt: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.body).toEqual({ granted: false });
  });

  it("flags Kao 5xx with reason:'kao_unreachable' so the dashboard can hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server error", { status: 503 }),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false, reason: "kao_unreachable" });
  });

  it("flags Kao network failure with reason:'kao_unreachable'", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false, reason: "kao_unreachable" });
  });

  it("flags Kao 401 (bad bearer) with reason:'kao_unauthorized'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false, reason: "kao_unauthorized" });
  });

  it("emits grantedAt:null rather than a fake epoch when Kao's grantedAt is null", async () => {
    // The dashboard renders null as "—" via fmtDateTime; an ISO epoch
    // would have rendered as "Dec 31, 1969, 7:00 PM" — actively misleading.
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
    expect(res.body.grantedAt).toBeNull();
  });

  it("emits grantedAt:null when Kao's grantedAt is a malformed string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "kizuna",
          granted: true,
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          grantedAt: "not-a-date",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.body.granted).toBe(true);
    // Defensive: unparseable string falls back to null instead of being
    // propagated to the dashboard where `new Date(s).toISOString()` would
    // throw RangeError on render.
    expect(res.body.grantedAt).toBeNull();
  });

  it("rejects non-boolean granted (e.g. Kao returns granted:'yes')", async () => {
    // Strict `=== true` check rejects truthy non-booleans that would
    // otherwise route a contract-drifted Kao response to the granted branch.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "kizuna",
          granted: "yes",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          grantedAt: "2026-04-01T12:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await request(h.app).get("/oauth/google/status");
    expect(res.body).toEqual({ granted: false });
  });
});
