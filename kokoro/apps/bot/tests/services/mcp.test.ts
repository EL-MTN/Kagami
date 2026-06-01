import { afterEach, describe, expect, it, vi } from "vitest";

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

import { mcpServerSchema } from "@kokoro/shared";
import {
  getMcpSummary,
  getMcpTools,
  initMcp,
  namespacedToolName,
  shutdownMcp,
} from "../../src/services/mcp";

afterEach(async () => {
  // Manager state is module-level; reset between cases.
  await shutdownMcp();
  vi.clearAllMocks();
});

describe("namespacedToolName", () => {
  it("prefixes with mcp_<server>_ so MCP tools never collide with the built-in palette", () => {
    expect(namespacedToolName("kioku", "recall")).toBe("mcp_kioku_recall");
  });

  it("sanitizes exotic characters in the tool segment to underscores", () => {
    expect(namespacedToolName("fs", "read/file.path")).toBe("mcp_fs_read_file_path");
  });

  it("caps the key at the 64-char provider tool-name ceiling", () => {
    const key = namespacedToolName("srv", "x".repeat(200));
    expect(key.length).toBe(64);
    expect(key.startsWith("mcp_srv_")).toBe(true);
  });
});

describe("mcpServerSchema", () => {
  it("accepts an http server", () => {
    const r = mcpServerSchema.safeParse({
      name: "kioku",
      transport: "http",
      url: "https://api.kioku.localhost/mcp",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an sse server with headers", () => {
    const r = mcpServerSchema.safeParse({
      name: "remote",
      transport: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer x" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a stdio server", () => {
    const r = mcpServerSchema.safeParse({
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a name with characters outside [a-zA-Z0-9_-]", () => {
    const r = mcpServerSchema.safeParse({
      name: "bad name",
      transport: "http",
      url: "https://example.com/mcp",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown transport", () => {
    const r = mcpServerSchema.safeParse({
      name: "x",
      transport: "ftp",
      url: "https://example.com/mcp",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an http server missing a url", () => {
    const r = mcpServerSchema.safeParse({ name: "x", transport: "http" });
    expect(r.success).toBe(false);
  });
});

describe("initMcp — fail-open", () => {
  it("is a no-op with no configured servers", async () => {
    await initMcp([]);
    expect(Object.keys(getMcpTools())).toHaveLength(0);
    expect(getMcpSummary()).toHaveLength(0);
  });

  it("skips an unreachable http server without throwing", async () => {
    // Nothing listens on 127.0.0.1:1 → connect refused. The bot must come up
    // anyway with zero MCP tools (the Kioku/Kizuna fail-open posture).
    await expect(
      initMcp([{ name: "down", transport: "http", url: "http://127.0.0.1:1/mcp" }]),
    ).resolves.toBeUndefined();
    expect(Object.keys(getMcpTools())).toHaveLength(0);
    expect(getMcpSummary()).toHaveLength(0);
  }, 20_000);

  it("skips a stdio server whose command does not exist without throwing", async () => {
    await expect(
      initMcp([{ name: "nocmd", transport: "stdio", command: "kokoro-no-such-binary-xyz" }]),
    ).resolves.toBeUndefined();
    expect(Object.keys(getMcpTools())).toHaveLength(0);
  }, 20_000);
});
