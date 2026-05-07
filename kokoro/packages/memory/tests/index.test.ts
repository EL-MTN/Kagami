import { setupMswServer } from "@kokoro/test-utils";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config, logger } from "@kokoro/shared";
import {
  KiokuClientError,
  appendFact,
  getFactById,
  getFactCount,
  ingestSession,
  recall,
} from "../src";

// Pin KIOKU_URL so MSW handlers match deterministically regardless of
// the developer's local .env. Restored in afterAll.
type ConfigWithKioku = { KIOKU_URL: string };
let originalUrl: string;

const KIOKU_BASE = "http://kioku.test";

const server = setupMswServer();

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

describe("recall", () => {
  it("posts the query + options and returns the facts array", async () => {
    let observedBody: unknown = null;
    server.use(
      http.post(`${KIOKU_BASE}/recall`, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          facts: [
            {
              id: "f1",
              text: "User lives in Brooklyn.",
              event_date: "2026-04-15",
              source_session: "smoke-1",
              created_at: "2026-04-15T10:00:00Z",
            },
          ],
          total: 1,
        });
      }),
    );

    const out = await recall("where do I live", { k: 5, since: "2026-01-01" });
    expect(observedBody).toEqual({
      query: "where do I live",
      k: 5,
      since: "2026-01-01",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "f1", text: "User lives in Brooklyn." });
  });

  it("throws KiokuClientError on a 4xx response with the parsed body", async () => {
    server.use(
      http.post(`${KIOKU_BASE}/recall`, () =>
        HttpResponse.json({ error: "validation_error" }, { status: 400 }),
      ),
    );

    await expect(recall("")).rejects.toMatchObject({
      name: "KiokuClientError",
      status: 400,
      body: { error: "validation_error" },
    });
  });
});

describe("appendFact", () => {
  it("returns the added result on 201", async () => {
    server.use(
      http.post(`${KIOKU_BASE}/facts`, () =>
        HttpResponse.json({ id: "new-id", status: "added" }, { status: 201 }),
      ),
    );

    const out = await appendFact({ text: "User likes ramen." });
    expect(out).toEqual({ id: "new-id", status: "added" });
  });

  it("returns the duplicate result on 200", async () => {
    server.use(
      http.post(`${KIOKU_BASE}/facts`, () =>
        HttpResponse.json(
          { id: "existing-id", status: "duplicate", reason: "hash" },
          { status: 200 },
        ),
      ),
    );

    const out = await appendFact({ text: "User likes ramen." });
    expect(out).toEqual({
      id: "existing-id",
      status: "duplicate",
      reason: "hash",
    });
  });
});

describe("getFactById", () => {
  it("returns the fact body when present", async () => {
    server.use(
      http.get(`${KIOKU_BASE}/facts/abc-123`, () =>
        HttpResponse.json({
          id: "abc-123",
          text: "User likes ramen.",
          user_id: "default",
          created_at: "2026-04-15T10:00:00Z",
          event_date: "2026-04-15",
          source_session: "smoke-1",
          hash: "h",
        }),
      ),
    );

    const out = await getFactById("abc-123");
    expect(out).toMatchObject({ id: "abc-123", text: "User likes ramen." });
  });

  it("returns null on 404 instead of throwing", async () => {
    server.use(
      http.get(`${KIOKU_BASE}/facts/missing`, () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );

    expect(await getFactById("missing")).toBeNull();
  });

  it("url-encodes the id so slashes and spaces don't break the path", async () => {
    let observedUrl: string | null = null;
    server.use(
      http.get(`${KIOKU_BASE}/facts/:id`, ({ request }) => {
        observedUrl = request.url;
        return HttpResponse.json({ error: "not_found" }, { status: 404 });
      }),
    );

    await getFactById("weird/id with space");
    expect(observedUrl).toBe(`${KIOKU_BASE}/facts/weird%2Fid%20with%20space`);
  });
});

describe("getFactCount", () => {
  it("unwraps the count field", async () => {
    server.use(http.get(`${KIOKU_BASE}/facts/count`, () => HttpResponse.json({ count: 42 })));

    expect(await getFactCount()).toBe(42);
  });
});

describe("ingestSession", () => {
  it("posts the transcript blob and returns the result envelope", async () => {
    let observedBody: unknown = null;
    server.use(
      http.post(`${KIOKU_BASE}/sessions`, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json(
          {
            sessionId: "s1",
            added: 3,
            batches: 2,
          },
          { status: 201 },
        );
      }),
    );

    const out = await ingestSession({
      transcript: "---\nid: s1\n---\n\n## t-1 user\nhi",
    });
    const transcript = (observedBody as { transcript: unknown }).transcript;
    expect(typeof transcript).toBe("string");
    expect(out).toEqual({
      sessionId: "s1",
      added: 3,
      batches: 2,
    });
  });
});

describe("error surface", () => {
  it("wraps transport failures in KiokuClientError", async () => {
    server.use(http.post(`${KIOKU_BASE}/recall`, () => HttpResponse.error()));

    await expect(recall("q")).rejects.toBeInstanceOf(KiokuClientError);
  });
});
