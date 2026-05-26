import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCalendarClient } from "../src/ingest/calendar-client.js";
import { makeGmailClient } from "../src/ingest/gmail-client.js";

// Verify the in-client `{ force: true }` retry path that recovers from a
// Google-side revocation mid-cache-window. The clients are responsible for
// asking the token getter to bypass Kao's own cache on 401/403 and trying
// once more before propagating the failure. Two attempts is intentional —
// a third would just be hammering Google with a known-dead token.

afterEach(() => {
  vi.restoreAllMocks();
});

function res(status: number, body: object = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("makeGmailClient — self-heal on 401", () => {
  it("retries once with force:true and succeeds when the fresh token works", async () => {
    const calls: Array<{ force: boolean }> = [];
    const getter = vi.fn(async (opts: { force?: boolean } = {}) => {
      calls.push({ force: Boolean(opts.force) });
      return opts.force ? "fresh-token" : "stale-token";
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(res(200, { emailAddress: "u@example.com", historyId: "h1" }));

    const client = makeGmailClient(getter);
    const profile = await client.getProfile();
    expect(profile).toEqual({ emailAddress: "u@example.com", historyId: "h1" });

    expect(calls).toEqual([{ force: false }, { force: true }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const headers1 = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const headers2 = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers1.authorization).toBe("Bearer stale-token");
    expect(headers2.authorization).toBe("Bearer fresh-token");
  });

  it("does not retry past the second attempt — second 401 escapes as GmailHttpError", async () => {
    const { GmailHttpError } = await import("../src/ingest/gmail-client.js");
    const getter = vi.fn(async () => "any-token");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(401, {}))
      .mockResolvedValueOnce(res(401, {}));

    const client = makeGmailClient(getter);
    try {
      await client.getProfile();
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GmailHttpError);
      expect((err as InstanceType<typeof GmailHttpError>).status).toBe(401);
    }
    expect(getter).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 403 — 403 escapes after the first attempt", async () => {
    // 403 from Google is usually permanent (insufficient scope, quota,
    // dailyLimitExceeded). A fresh access token won't help, so the client
    // does NOT trigger the force-refresh path — the 403 escapes immediately
    // as GmailHttpError and the worker records it via recordFailedRun.
    const getter = vi.fn(async () => "any-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res(403, {}));

    const client = makeGmailClient(getter);
    await expect(client.getProfile()).rejects.toMatchObject({ status: 403 });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("makeCalendarClient — self-heal on 401", () => {
  it("retries once with force:true and succeeds", async () => {
    const calls: Array<{ force: boolean }> = [];
    const getter = vi.fn(async (opts: { force?: boolean } = {}) => {
      calls.push({ force: Boolean(opts.force) });
      return opts.force ? "fresh-token" : "stale-token";
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(401, {}))
      .mockResolvedValueOnce(res(200, { items: [] }));

    const client = makeCalendarClient(getter);
    const out = await client.listEvents({ timeMin: "2026-01-01T00:00:00.000Z" });
    expect(out).toEqual({ items: [] });
    expect(calls).toEqual([{ force: false }, { force: true }]);
  });
});
