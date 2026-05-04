import { setupMswServer, withTestDb } from "@kokoro/test-utils";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config, logger } from "@kokoro/shared";
import { Conversation, type IConversation } from "@kokoro/db";
import { sweepPendingIngests, sweepStaleActiveSessions } from "../src/sweeper";

withTestDb();

const KIOKU_BASE = "http://kioku.test";
const server = setupMswServer();

type ConfigWithKioku = { KIOKU_URL: string };
let originalUrl: string;

beforeAll(() => {
  originalUrl = config.KIOKU_URL;
  (config as unknown as ConfigWithKioku).KIOKU_URL = KIOKU_BASE;
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  (config as unknown as ConfigWithKioku).KIOKU_URL = originalUrl;
  vi.restoreAllMocks();
});

interface ConvoOverrides {
  ingestStatus?: "pending" | "done";
  status?: "active" | "closed";
  closedAt?: Date;
  updatedAt?: Date;
  withMessages?: boolean;
}

async function makeConvo(overrides: ConvoOverrides = {}): Promise<IConversation> {
  const convo = await Conversation.create({
    chatId: "c1",
    userId: "u1",
    platform: "telegram",
    status: overrides.status ?? "closed",
    closedAt: overrides.closedAt ?? new Date(Date.now() - 10 * 60_000),
    ingestStatus: overrides.ingestStatus ?? "pending",
    messages: overrides.withMessages
      ? [
          { role: "user", content: "hi", timestamp: new Date() },
          { role: "assistant", content: "hello", timestamp: new Date() },
        ]
      : [],
  });
  if (overrides.updatedAt) {
    // Mongoose's `timestamps: true` schema option re-stamps `updatedAt`
    // on every updateOne by default; pass `timestamps: false` so our
    // explicit override sticks.
    await Conversation.updateOne(
      { _id: convo._id },
      { $set: { updatedAt: overrides.updatedAt } },
      { timestamps: false },
    );
    return (await Conversation.findById(convo._id))!;
  }
  return convo;
}

describe("sweepPendingIngests", () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  it("reconciles status to 'done' without re-ingesting when facts already exist for the session", async () => {
    const convo = await makeConvo({ withMessages: true });
    let sessionsCalls = 0;
    server.use(
      http.get(`${KIOKU_BASE}/facts`, () =>
        HttpResponse.json({ total: 3, limit: 1, offset: 0, facts: [] }),
      ),
      http.post(`${KIOKU_BASE}/sessions`, () => {
        sessionsCalls += 1;
        return HttpResponse.json({ sessionId: "x", added: 0, batches: 0, summaryFactId: null });
      }),
    );

    const result = await sweepPendingIngests();

    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.ingested).toBe(0);
    expect(sessionsCalls).toBe(0);

    const fresh = await Conversation.findById(convo._id);
    expect(fresh?.ingestStatus).toBe("done");
    expect(fresh?.ingestedAt).toBeInstanceOf(Date);
  });

  it("ingests when no facts exist yet for the session, then marks done", async () => {
    const convo = await makeConvo({ withMessages: true });
    server.use(
      http.get(`${KIOKU_BASE}/facts`, () =>
        HttpResponse.json({ total: 0, limit: 1, offset: 0, facts: [] }),
      ),
      http.post(`${KIOKU_BASE}/sessions`, () =>
        HttpResponse.json(
          { sessionId: "x", added: 5, batches: 2, summaryFactId: "s1" },
          { status: 201 },
        ),
      ),
    );

    const result = await sweepPendingIngests();

    expect(result.ingested).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(result.failed).toBe(0);

    const fresh = await Conversation.findById(convo._id);
    expect(fresh?.ingestStatus).toBe("done");
  });

  it("leaves status pending and counts as failed when Kioku ingest errors", async () => {
    const convo = await makeConvo({ withMessages: true });
    server.use(
      http.get(`${KIOKU_BASE}/facts`, () =>
        HttpResponse.json({ total: 0, limit: 1, offset: 0, facts: [] }),
      ),
      http.post(`${KIOKU_BASE}/sessions`, () =>
        HttpResponse.json({ error: "boom" }, { status: 503 }),
      ),
    );

    const result = await sweepPendingIngests();

    expect(result.failed).toBe(1);
    const fresh = await Conversation.findById(convo._id);
    expect(fresh?.ingestStatus).toBe("pending");
    expect(fresh?.ingestAttempts).toBe(1);
  });

  it("skips sessions closed within the staleness window so the immediate trigger has time to land", async () => {
    await makeConvo({
      withMessages: true,
      closedAt: new Date(Date.now() - 10_000), // 10s ago, well inside default 60s window
    });
    server.use(
      http.get(`${KIOKU_BASE}/facts`, () => {
        throw new Error("probe should not be called for fresh-closed sessions");
      }),
    );

    const result = await sweepPendingIngests();
    expect(result.scanned).toBe(0);
  });

  it("marks empty-content sessions done immediately without hitting Kioku", async () => {
    const convo = await makeConvo({ withMessages: false });
    server.use(
      http.get(`${KIOKU_BASE}/facts`, () =>
        HttpResponse.json({ total: 0, limit: 1, offset: 0, facts: [] }),
      ),
      http.post(`${KIOKU_BASE}/sessions`, () => {
        throw new Error("ingest should not run for empty sessions");
      }),
    );

    const result = await sweepPendingIngests();
    expect(result.scanned).toBe(1);
    expect(result.ingested).toBe(1);
    const fresh = await Conversation.findById(convo._id);
    expect(fresh?.ingestStatus).toBe("done");
  });

  it("attempts ingest anyway when the probe fails, so a probe outage doesn't block recovery", async () => {
    const convo = await makeConvo({ withMessages: true });
    server.use(
      http.get(`${KIOKU_BASE}/facts`, () => HttpResponse.json({ error: "boom" }, { status: 503 })),
      http.post(`${KIOKU_BASE}/sessions`, () =>
        HttpResponse.json(
          { sessionId: "x", added: 1, batches: 1, summaryFactId: null },
          { status: 201 },
        ),
      ),
    );

    const result = await sweepPendingIngests();
    expect(result.ingested).toBe(1);
    const fresh = await Conversation.findById(convo._id);
    expect(fresh?.ingestStatus).toBe("done");
  });

  it("picks up legacy conversations whose ingestStatus field was never set (pre-PR docs)", async () => {
    // Insert a doc directly with ingestStatus absent — bypasses Mongoose
    // schema defaults to simulate a Conversation that closed before the
    // ingestStatus field was added.
    const raw = await Conversation.collection.insertOne({
      chatId: "c-legacy",
      userId: "u-legacy",
      platform: "telegram",
      sessionId: "legacy-session",
      status: "closed",
      closedAt: new Date(Date.now() - 10 * 60_000),
      messages: [{ role: "user", content: "hi", timestamp: new Date() }],
      createdAt: new Date(Date.now() - 11 * 60_000),
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });

    server.use(
      http.get(`${KIOKU_BASE}/facts`, () =>
        HttpResponse.json({ total: 0, limit: 1, offset: 0, facts: [] }),
      ),
      http.post(`${KIOKU_BASE}/sessions`, () =>
        HttpResponse.json(
          { sessionId: "legacy-session", added: 2, batches: 1, summaryFactId: "s" },
          { status: 201 },
        ),
      ),
    );

    const result = await sweepPendingIngests();
    expect(result.scanned).toBe(1);
    expect(result.ingested).toBe(1);

    const fresh = await Conversation.findById(raw.insertedId);
    expect(fresh?.ingestStatus).toBe("done");
  });
});

describe("sweepStaleActiveSessions", () => {
  it("closes active sessions idle past the threshold and leaves ingestStatus pending", async () => {
    const stale = await makeConvo({
      status: "active",
      updatedAt: new Date(Date.now() - 7 * 60 * 60_000), // 7h ago, past 6h default
    });
    const fresh = await makeConvo({
      status: "active",
      updatedAt: new Date(Date.now() - 1 * 60 * 60_000), // 1h ago, well under
    });

    const result = await sweepStaleActiveSessions();

    expect(result.closed).toBe(1);

    const staleFresh = await Conversation.findById(stale._id);
    expect(staleFresh?.status).toBe("closed");
    expect(staleFresh?.closedAt).toBeInstanceOf(Date);
    expect(staleFresh?.ingestStatus).toBe("pending");

    const freshFresh = await Conversation.findById(fresh._id);
    expect(freshFresh?.status).toBe("active");
  });

  it("explicitly sets ingestStatus: 'pending' on close so legacy active docs are pickable by the next sweep", async () => {
    // Direct Mongo insert without ingestStatus, simulating a legacy
    // active session that pre-dates the field. After close, the field
    // must be set explicitly — schema defaults don't fire on
    // already-loaded documents that lack the field.
    const raw = await Conversation.collection.insertOne({
      chatId: "c-legacy-active",
      userId: "u-legacy",
      platform: "telegram",
      sessionId: "legacy-active-session",
      status: "active",
      messages: [{ role: "user", content: "hi", timestamp: new Date() }],
      createdAt: new Date(Date.now() - 8 * 60 * 60_000),
      updatedAt: new Date(Date.now() - 8 * 60 * 60_000),
    });
    // Force updatedAt to past the staleness window via raw write so
    // mongoose's timestamps don't re-stamp it.
    await Conversation.collection.updateOne(
      { _id: raw.insertedId },
      { $set: { updatedAt: new Date(Date.now() - 8 * 60 * 60_000) } },
    );

    const result = await sweepStaleActiveSessions();
    expect(result.closed).toBe(1);

    const fresh = await Conversation.findById(raw.insertedId);
    expect(fresh?.status).toBe("closed");
    expect(fresh?.ingestStatus).toBe("pending");
  });

  it("respects a custom idleHours value", async () => {
    await makeConvo({
      status: "active",
      updatedAt: new Date(Date.now() - 3 * 60 * 60_000), // 3h ago
    });

    const tight = await sweepStaleActiveSessions({ idleHours: 2 });
    expect(tight.closed).toBe(1);
  });
});
