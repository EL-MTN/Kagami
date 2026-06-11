import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin the workspace quotas so a stray WORKSPACE_* in the test environment
// can't bend the quota assertions below.
vi.mock("@kokoro/shared", async (orig) => {
  const real = await orig<typeof import("@kokoro/shared")>();
  return {
    ...real,
    config: {
      ...real.config,
      WORKSPACE_MAX_FILE_MB: 1,
      WORKSPACE_MAX_TOTAL_MB: 2,
      WORKSPACE_MAX_FILES: 3,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

const {
  mockGetByPath,
  mockGetTotals,
  mockListFiles,
  mockReadBlob,
  mockRemoveBlob,
  mockSoftDelete,
  mockUpsert,
  mockWriteBlob,
} = vi.hoisted(() => ({
  mockGetByPath: vi.fn(),
  mockGetTotals: vi.fn(),
  mockListFiles: vi.fn(),
  mockReadBlob: vi.fn(),
  mockRemoveBlob: vi.fn(),
  mockSoftDelete: vi.fn(),
  mockUpsert: vi.fn(),
  mockWriteBlob: vi.fn(),
}));

vi.mock("@kokoro/db", () => ({
  generateWorkspaceKey: () => "fresh-key",
  getWorkspaceFileByPath: mockGetByPath,
  getWorkspaceTotals: mockGetTotals,
  listWorkspaceFiles: mockListFiles,
  readWorkspaceBlob: mockReadBlob,
  removeWorkspaceBlob: mockRemoveBlob,
  softDeleteWorkspaceFile: mockSoftDelete,
  upsertWorkspaceFile: mockUpsert,
  writeWorkspaceBlob: mockWriteBlob,
}));

import {
  WorkspaceError,
  deleteWorkspaceFile,
  guessMimeType,
  humanBytes,
  isTextFile,
  listWorkspace,
  normalizeWorkspacePath,
  readWorkspaceFile,
  workspaceSummary,
  writeWorkspaceFile,
} from "../../src/services/workspace";

const MB = 1024 * 1024;

function row(path: string, overrides: Record<string, unknown> = {}) {
  return {
    path,
    gridfsKey: `key-${path}`,
    size: 100,
    mimeType: "text/plain",
    source: "agent",
    sourceChatId: "chat-1",
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByPath.mockResolvedValue(null);
  mockGetTotals.mockResolvedValue({ count: 0, totalBytes: 0 });
  mockListFiles.mockResolvedValue([]);
  mockUpsert.mockResolvedValue({ previousGridfsKey: null });
});

describe("normalizeWorkspacePath", () => {
  it("passes clean relative paths through, trimming outer whitespace", () => {
    expect(normalizeWorkspacePath("notes.md")).toBe("notes.md");
    expect(normalizeWorkspacePath("  reports/2026/june.csv ")).toBe("reports/2026/june.csv");
    expect(normalizeWorkspacePath("日本語/メモ.txt")).toBe("日本語/メモ.txt");
    expect(normalizeWorkspacePath("with space.txt")).toBe("with space.txt");
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["/etc/passwd", "relative"],
    ["a/../b.txt", "not allowed"],
    ["..", "not allowed"],
    ["./a.txt", "not allowed"],
    ["a//b.txt", "empty segment"],
    ["a/b/", "empty segment"],
    ["a\\b.txt", "forbidden"],
    ["bad\u0000name.txt", "forbidden"],
    ["a/ leading.txt", "whitespace"],
    ["a/b/c/d/e/f/g/h/i.txt", "directory levels"],
    ["x".repeat(513), "characters"],
  ])("rejects %j", (path, fragment) => {
    expect(() => normalizeWorkspacePath(path)).toThrowError(WorkspaceError);
    expect(() => normalizeWorkspacePath(path)).toThrowError(fragment);
  });
});

describe("guessMimeType / isTextFile / humanBytes", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(guessMimeType("a/b.md")).toBe("text/markdown");
    expect(guessMimeType("data.CSV")).toBe("text/csv");
    expect(guessMimeType("archive.tar.gz")).toBe("application/octet-stream");
  });

  it("treats text mimes and NUL-free unknown bytes as text", () => {
    expect(isTextFile("text/csv", Buffer.from("a,b"))).toBe(true);
    expect(isTextFile("application/json", Buffer.from("{}"))).toBe(true);
    expect(isTextFile("application/pdf", Buffer.from("%PDF-1.7"))).toBe(false);
    expect(isTextFile("application/octet-stream", Buffer.from("plain text"))).toBe(true);
    expect(isTextFile("application/octet-stream", Buffer.from([0x50, 0x00, 0x4b]))).toBe(false);
  });

  it("formats sizes at B/KB/MB granularity", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(3 * MB)).toBe("3.0 MB");
  });
});

describe("writeWorkspaceFile", () => {
  const base = { path: "out.txt", data: Buffer.from("hello"), source: "agent" as const };

  it("writes the blob before the row and reports the result", async () => {
    const order: string[] = [];
    mockWriteBlob.mockImplementation(() => {
      order.push("blob");
      return Promise.resolve();
    });
    mockUpsert.mockImplementation(() => {
      order.push("row");
      return Promise.resolve({ previousGridfsKey: null });
    });

    const result = await writeWorkspaceFile({ ...base, sourceChatId: "chat-1" });

    expect(order).toEqual(["blob", "row"]);
    expect(mockWriteBlob).toHaveBeenCalledWith("fresh-key", base.data, "text/plain");
    expect(mockUpsert).toHaveBeenCalledWith({
      path: "out.txt",
      gridfsKey: "fresh-key",
      size: 5,
      mimeType: "text/plain",
      source: "agent",
      sourceChatId: "chat-1",
    });
    expect(result).toEqual({
      path: "out.txt",
      size: 5,
      mimeType: "text/plain",
      overwritten: false,
    });
    expect(mockRemoveBlob).not.toHaveBeenCalled();
  });

  it("removes the replaced generation's blob after an overwrite", async () => {
    mockGetByPath.mockResolvedValue(row("out.txt", { gridfsKey: "stale-key", size: 50 }));
    mockGetTotals.mockResolvedValue({ count: 1, totalBytes: 50 });
    mockUpsert.mockResolvedValue({ previousGridfsKey: "stale-key" });

    const result = await writeWorkspaceFile({ ...base, overwrite: true });

    expect(result.overwritten).toBe(true);
    expect(mockRemoveBlob).toHaveBeenCalledWith("stale-key");
  });

  it("refuses to clobber an existing file without overwrite", async () => {
    mockGetByPath.mockResolvedValue(row("out.txt"));
    await expect(writeWorkspaceFile(base)).rejects.toThrowError(/already exists.*overwrite/);
    expect(mockWriteBlob).not.toHaveBeenCalled();
  });

  it("rejects a file above the per-file cap", async () => {
    await expect(writeWorkspaceFile({ ...base, data: Buffer.alloc(MB + 1) })).rejects.toThrowError(
      /per-file cap/,
    );
  });

  it("rejects a write that would breach the total-size cap, net of the replaced file", async () => {
    mockGetByPath.mockResolvedValue(row("out.txt", { size: MB }));
    mockGetTotals.mockResolvedValue({ count: 2, totalBytes: 2 * MB });
    // Replacing a 1 MB file with 0.9 MB shrinks usage — allowed even at cap.
    await expect(
      writeWorkspaceFile({ ...base, data: Buffer.alloc(0.9 * MB), overwrite: true }),
    ).resolves.toMatchObject({ overwritten: true });

    // A fresh 0.9 MB file on top of 2 MB breaches the 2 MB cap.
    mockGetByPath.mockResolvedValue(null);
    await expect(
      writeWorkspaceFile({ ...base, path: "new.txt", data: Buffer.alloc(0.9 * MB) }),
    ).rejects.toThrowError(/workspace is full/);
  });

  it("rejects a fresh file when the file-count cap is reached", async () => {
    mockGetTotals.mockResolvedValue({ count: 3, totalBytes: 0 });
    await expect(writeWorkspaceFile(base)).rejects.toThrowError(/file cap/);
  });

  it("succeeds even when stale-blob removal fails", async () => {
    mockGetByPath.mockResolvedValue(row("out.txt"));
    mockGetTotals.mockResolvedValue({ count: 1, totalBytes: 100 });
    mockUpsert.mockResolvedValue({ previousGridfsKey: "stale-key" });
    mockRemoveBlob.mockRejectedValue(new Error("gridfs hiccup"));

    await expect(writeWorkspaceFile({ ...base, overwrite: true })).resolves.toMatchObject({
      overwritten: true,
    });
  });
});

describe("readWorkspaceFile", () => {
  it("returns bytes with row metadata", async () => {
    mockGetByPath.mockResolvedValue(row("a.txt"));
    mockReadBlob.mockResolvedValue({ data: Buffer.from("content"), mimeType: "text/plain" });

    const result = await readWorkspaceFile("a.txt");
    expect(result.data.toString()).toBe("content");
    expect(result.mimeType).toBe("text/plain");
    expect(result.size).toBe(100);
  });

  it("throws WorkspaceError for a missing file", async () => {
    await expect(readWorkspaceFile("ghost.txt")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("throws WorkspaceError when the row has no blob behind it", async () => {
    mockGetByPath.mockResolvedValue(row("torn.txt"));
    mockReadBlob.mockResolvedValue(null);
    await expect(readWorkspaceFile("torn.txt")).rejects.toThrowError(/corrupted/);
  });
});

describe("listWorkspace", () => {
  it("filters by directory prefix without matching sibling names", async () => {
    mockListFiles.mockResolvedValue([
      row("reports/june.csv"),
      row("reports2/other.csv"),
      row("reports"),
    ]);

    const listing = await listWorkspace("reports");
    expect(listing.files.map((f) => f.path)).toEqual(["reports/june.csv", "reports"]);
    expect(listing.count).toBe(2);
    expect(listing.totalBytes).toBe(200);
  });
});

describe("deleteWorkspaceFile", () => {
  it("throws WorkspaceError when nothing lives at the path", async () => {
    mockSoftDelete.mockResolvedValue(null);
    await expect(deleteWorkspaceFile("nope.txt")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("soft-deletes via the db layer", async () => {
    mockSoftDelete.mockResolvedValue(row("bye.txt"));
    await expect(deleteWorkspaceFile("bye.txt")).resolves.toBeUndefined();
    expect(mockSoftDelete).toHaveBeenCalledWith("bye.txt");
  });
});

describe("workspaceSummary", () => {
  it("returns null for an empty workspace", async () => {
    expect(await workspaceSummary()).toBeNull();
  });

  it("lists most-recently-updated paths first with totals", async () => {
    mockListFiles.mockResolvedValue([
      row("old.txt", { updatedAt: new Date("2026-01-01"), size: 1024 }),
      row("new.txt", { updatedAt: new Date("2026-06-01"), size: 1024 }),
    ]);

    const summary = await workspaceSummary();
    expect(summary).toContain("(2, 2.0 KB)");
    expect(summary!.indexOf("new.txt")).toBeLessThan(summary!.indexOf("old.txt"));
  });

  it("caps the path list and counts the remainder", async () => {
    mockListFiles.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        row(`f${i}.txt`, { updatedAt: new Date(2026, 0, i + 1) }),
      ),
    );

    const summary = await workspaceSummary();
    expect(summary).toContain("+2 more");
  });
});

describe("sanitizeFileName", () => {
  it("passes ordinary names through and keeps unicode", async () => {
    const { sanitizeFileName } = await import("../../src/services/workspace");
    expect(sanitizeFileName("lease.pdf")).toBe("lease.pdf");
    expect(sanitizeFileName("メモ 2026.txt")).toBe("メモ 2026.txt");
  });

  it("flattens path separators and falls back for empty/dot-only names", async () => {
    const { sanitizeFileName } = await import("../../src/services/workspace");
    expect(sanitizeFileName("../../etc/passwd")).toBe("..-..-etc-passwd");
    expect(sanitizeFileName("a\\b.txt")).toBe("a-b.txt");
    expect(sanitizeFileName(undefined, "application/pdf")).toBe("file.pdf");
    expect(sanitizeFileName("...", "text/csv")).toBe("file.csv");
    expect(sanitizeFileName(undefined)).toBe("file");
  });

  it("caps long names preserving the extension", async () => {
    const { sanitizeFileName } = await import("../../src/services/workspace");
    const long = `${"x".repeat(200)}.pdf`;
    const out = sanitizeFileName(long);
    expect(out.length).toBe(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("saveInboundDocument", () => {
  it("saves under inbox/ with chat-upload provenance", async () => {
    const { saveInboundDocument } = await import("../../src/services/workspace");
    await saveInboundDocument({
      fileName: "lease.pdf",
      data: Buffer.from("pdf"),
      mimeType: "application/pdf",
      sourceChatId: "chat-9",
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "inbox/lease.pdf",
        mimeType: "application/pdf",
        source: "chat-upload",
        sourceChatId: "chat-9",
      }),
    );
  });

  it("dedupes occupied names with numbered siblings", async () => {
    const { saveInboundDocument } = await import("../../src/services/workspace");
    // inbox/lease.pdf and inbox/lease-2.pdf exist; lease-3 is free.
    mockGetByPath.mockImplementation((path: string) =>
      Promise.resolve(
        path === "inbox/lease.pdf" || path === "inbox/lease-2.pdf" ? row(path) : null,
      ),
    );

    const result = await saveInboundDocument({
      fileName: "lease.pdf",
      data: Buffer.from("pdf"),
      sourceChatId: "chat-9",
    });

    expect(result.path).toBe("inbox/lease-3.pdf");
  });
});
