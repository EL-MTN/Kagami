import { fakeAdapter } from "@kokoro/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockAcquireBrowser, mockReleaseBrowser, mockResetBrowser } = vi.hoisted(() => ({
  mockAcquireBrowser: vi.fn(),
  mockReleaseBrowser: vi.fn(),
  mockResetBrowser: vi.fn(),
}));
vi.mock("../../../src/services/browser", () => ({
  acquireBrowser: mockAcquireBrowser,
  releaseBrowser: mockReleaseBrowser,
  resetBrowser: mockResetBrowser,
  withBrowserLock: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));

import { createBrowseTool, createReadOnlyBrowseTool } from "../../../src/ai/tools/browse";

interface ExecutableTool {
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

interface FakeStagehand {
  context: {
    pages: () => Array<{
      goto: ReturnType<typeof vi.fn>;
      evaluate: ReturnType<typeof vi.fn>;
      screenshot: ReturnType<typeof vi.fn>;
    }>;
  };
  extract: ReturnType<typeof vi.fn>;
  act: ReturnType<typeof vi.fn>;
  agent: () => { execute: ReturnType<typeof vi.fn> };
}

function fakeStagehand(): FakeStagehand {
  const page = {
    goto: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn(() => Promise.resolve("body text")),
    screenshot: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
  };
  return {
    context: { pages: () => [page] },
    extract: vi.fn(),
    act: vi.fn(() => Promise.resolve()),
    agent: () => ({ execute: vi.fn(() => Promise.resolve("agent done")) }),
  };
}

beforeEach(() => {
  mockAcquireBrowser.mockReset();
  mockReleaseBrowser.mockReset();
  mockResetBrowser.mockReset();
});

describe("browse — readOnly", () => {
  const tool = createReadOnlyBrowseTool() as unknown as ExecutableTool;

  it("search visits DuckDuckGo HTML and returns up to 10 results", async () => {
    const sh = fakeStagehand();
    sh.extract.mockResolvedValue([{ title: "t1", url: "https://x", snippet: "s1" }]);
    mockAcquireBrowser.mockResolvedValue(sh);

    const result = await tool.execute({ action: "search", query: "node testing" });
    expect(result.success).toBe(true);
    expect(result.query).toBe("node testing");
    expect((result.results as unknown[]).length).toBe(1);
    expect(mockReleaseBrowser).toHaveBeenCalledTimes(1);
  });

  it("requires query for search", async () => {
    mockAcquireBrowser.mockResolvedValue(fakeStagehand());
    const result = await tool.execute({ action: "search" });
    expect(result).toEqual({ success: false, reason: "query is required for search" });
  });

  it("visit normalizes a bare URL with https:// and truncates body to 4000 chars", async () => {
    const sh = fakeStagehand();
    sh.context.pages()[0].evaluate = vi.fn(() => Promise.resolve("a".repeat(5000)));
    mockAcquireBrowser.mockResolvedValue(sh);

    const result = await tool.execute({ action: "visit", url: "example.com" });
    expect(result.url).toBe("https://example.com");
    expect((result.text as string).length).toBe(4000);
    expect(result.truncated).toBe(true);
  });

  it("calls resetBrowser on Target-closed error", async () => {
    mockAcquireBrowser.mockRejectedValue(new Error("Target closed: tab gone"));
    const result = await tool.execute({ action: "visit", url: "https://x" });
    expect(result.success).toBe(false);
    expect(mockResetBrowser).toHaveBeenCalledTimes(1);
  });

  it("does NOT call resetBrowser on a generic error", async () => {
    mockAcquireBrowser.mockRejectedValue(new Error("transient flake"));
    await tool.execute({ action: "visit", url: "https://x" });
    expect(mockResetBrowser).not.toHaveBeenCalled();
  });
});

describe("browse — full mode", () => {
  it("act delegates to stagehand.act and releases", async () => {
    const sh = fakeStagehand();
    mockAcquireBrowser.mockResolvedValue(sh);
    const adapter = fakeAdapter();
    const tool = createBrowseTool("chat-1", adapter) as unknown as ExecutableTool;

    const result = await tool.execute({
      action: "act",
      instruction: "click the login button",
    });
    expect(result).toEqual({ success: true, performed: "click the login button" });
    expect(sh.act).toHaveBeenCalledWith("click the login button");
    expect(mockReleaseBrowser).toHaveBeenCalledTimes(1);
  });

  it("screenshot sends the photo via the adapter", async () => {
    const sh = fakeStagehand();
    mockAcquireBrowser.mockResolvedValue(sh);
    const adapter = fakeAdapter();
    const tool = createBrowseTool("chat-1", adapter) as unknown as ExecutableTool;

    const result = await tool.execute({ action: "screenshot" });
    expect(result).toEqual({ success: true, sent: true });
    expect(adapter.calls.sendPhotoBuffer).toHaveLength(1);
    expect(adapter.calls.sendPhotoBuffer[0].chatId).toBe("chat-1");
  });

  // Inline autonomous `agent` was removed — a 25-step run can't fit the
  // per-action timeout. Autonomous browsing is the confirmation-gated
  // `browseAgent` (services/gated-actions.ts), covered by its own tests.

  it("login keeps the browser alive and returns waitingForUser:true", async () => {
    const sh = fakeStagehand();
    sh.context.pages()[0].evaluate = vi.fn(() => Promise.resolve("Login Page"));
    mockAcquireBrowser.mockResolvedValue(sh);
    const tool = createBrowseTool("chat-1", fakeAdapter()) as unknown as ExecutableTool;

    const result = await tool.execute({ action: "login", url: "https://example.com/login" });
    expect(result).toMatchObject({
      success: true,
      url: "https://example.com/login",
      title: "Login Page",
      waitingForUser: true,
    });
    expect(mockReleaseBrowser).not.toHaveBeenCalled();
  });

  it("each action requires its specific input", async () => {
    mockAcquireBrowser.mockResolvedValue(fakeStagehand());
    const tool = createBrowseTool("chat-1", fakeAdapter()) as unknown as ExecutableTool;

    expect(await tool.execute({ action: "search" })).toMatchObject({ success: false });
    expect(await tool.execute({ action: "visit" })).toMatchObject({ success: false });
    expect(await tool.execute({ action: "extract" })).toMatchObject({ success: false });
    expect(await tool.execute({ action: "act" })).toMatchObject({ success: false });
    expect(await tool.execute({ action: "login" })).toMatchObject({ success: false });
  });
});

describe("browse — input schema tracks the allowed action set", () => {
  function shapeKeys(t: unknown): string[] {
    const schema = (t as { inputSchema: { shape: Record<string, unknown> } }).inputSchema;
    return Object.keys(schema.shape);
  }

  it("omits the dead query field when search is excluded", () => {
    expect(
      shapeKeys(createBrowseTool("chat-1", fakeAdapter(), { includeSearch: false })),
    ).not.toContain("query");
    expect(shapeKeys(createReadOnlyBrowseTool({ includeSearch: false }))).not.toContain("query");
  });

  it("keeps the query field when search is included", () => {
    expect(shapeKeys(createBrowseTool("chat-1", fakeAdapter()))).toContain("query");
    expect(shapeKeys(createReadOnlyBrowseTool())).toContain("query");
  });
});

describe("browse — visit pagination", () => {
  it("slices from offset and reports offset/totalChars/truncated", async () => {
    const sh = fakeStagehand();
    const longText = "a".repeat(4000) + "b".repeat(100);
    sh.context.pages()[0].evaluate = vi.fn(() => Promise.resolve(longText));
    mockAcquireBrowser.mockResolvedValue(sh);
    const tool = createReadOnlyBrowseTool() as unknown as ExecutableTool;

    const first = await tool.execute({ action: "visit", url: "example.com" });
    expect(first).toMatchObject({ success: true, offset: 0, totalChars: 4100, truncated: true });
    expect((first.text as string).length).toBe(4000);

    const second = await tool.execute({ action: "visit", url: "example.com", offset: 4000 });
    expect(second).toMatchObject({ success: true, offset: 4000, truncated: false });
    expect(second.text).toBe("b".repeat(100));
  });
});
