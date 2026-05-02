import { setupMswServer } from "@mashiro/test-utils";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config, logger } from "@mashiro/shared";
import { webSearch } from "../../src/services/web-search";

// Mutate the live config object so the service sees a deterministic API key
// regardless of the developer's local .env. Restored in afterAll.
type ConfigWithBrave = { BRAVE_SEARCH_API_KEY: string | undefined };

const server = setupMswServer();
const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
let originalKey: string | undefined;

beforeAll(() => {
  originalKey = config.BRAVE_SEARCH_API_KEY;
  (config as unknown as ConfigWithBrave).BRAVE_SEARCH_API_KEY = "test-key";
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  (config as unknown as ConfigWithBrave).BRAVE_SEARCH_API_KEY = originalKey;
  vi.restoreAllMocks();
});

afterEach(() => {
  server.resetHandlers();
});

describe("webSearch", () => {
  it("maps Brave's web.results into {title, url, snippet} and strips HTML highlights", async () => {
    server.use(
      http.get(BRAVE_URL, ({ request }) => {
        // Verify auth header and query params reach Brave correctly.
        expect(request.headers.get("X-Subscription-Token")).toBe("test-key");
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe("typescript monorepo");
        expect(url.searchParams.get("count")).toBe("5");
        return HttpResponse.json({
          web: {
            results: [
              {
                title: "TypeScript <strong>monorepo</strong>",
                url: "https://example.com/a",
                description: "A guide to <strong>monorepo</strong> setups.",
              },
              {
                title: "Another result",
                url: "https://example.com/b",
                description: "Plain description.",
              },
            ],
          },
        });
      }),
    );

    const results = await webSearch("typescript monorepo");
    expect(results).toEqual([
      {
        title: "TypeScript monorepo",
        url: "https://example.com/a",
        snippet: "A guide to monorepo setups.",
      },
      {
        title: "Another result",
        url: "https://example.com/b",
        snippet: "Plain description.",
      },
    ]);
  });

  it("clamps count into Brave's 1–20 range and forwards it on the URL", async () => {
    let observedCount: string | null = null;
    server.use(
      http.get(BRAVE_URL, ({ request }) => {
        observedCount = new URL(request.url).searchParams.get("count");
        return HttpResponse.json({ web: { results: [] } });
      }),
    );

    await webSearch("q", { count: 999 });
    expect(observedCount).toBe("20");
  });

  it("skips entries missing a title or url so the LLM never sees half-built results", async () => {
    server.use(
      http.get(BRAVE_URL, () =>
        HttpResponse.json({
          web: {
            results: [
              { url: "https://no-title.example", description: "x" },
              { title: "no url", description: "x" },
              { title: "good", url: "https://good.example", description: "x" },
            ],
          },
        }),
      ),
    );

    const results = await webSearch("q");
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://good.example");
  });

  it("surfaces a clear error on 401 (bad API key)", async () => {
    server.use(http.get(BRAVE_URL, () => new HttpResponse(null, { status: 401 })));
    await expect(webSearch("q")).rejects.toThrow(/401/);
  });

  it("surfaces a clear error on 429 (rate limit)", async () => {
    server.use(http.get(BRAVE_URL, () => new HttpResponse(null, { status: 429 })));
    await expect(webSearch("q")).rejects.toThrow(/429/);
  });

  it("surfaces non-401/429 status codes verbatim", async () => {
    server.use(http.get(BRAVE_URL, () => new HttpResponse(null, { status: 503 })));
    await expect(webSearch("q")).rejects.toThrow(/503/);
  });
});

describe("webSearch — no API key configured", () => {
  it("throws so callers can fail loudly instead of silently returning []", async () => {
    const previous = config.BRAVE_SEARCH_API_KEY;
    (config as unknown as ConfigWithBrave).BRAVE_SEARCH_API_KEY = undefined;
    try {
      await expect(webSearch("q")).rejects.toThrow(/not configured/);
    } finally {
      (config as unknown as ConfigWithBrave).BRAVE_SEARCH_API_KEY = previous;
    }
  });
});
