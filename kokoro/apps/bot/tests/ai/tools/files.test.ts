import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig<typeof import("@kokoro/shared")>()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { mockDelete, mockList, mockRead, mockWrite } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockList: vi.fn(),
  mockRead: vi.fn(),
  mockWrite: vi.fn(),
}));

// Mock only the I/O surface — WorkspaceError, isTextFile, and humanBytes stay
// real so the tools' classification and formatting paths are actually tested.
vi.mock("../../../src/services/workspace", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/workspace")>()),
  deleteWorkspaceFile: mockDelete,
  listWorkspace: mockList,
  readWorkspaceFile: mockRead,
  writeWorkspaceFile: mockWrite,
}));

import { WorkspaceError } from "../../../src/services/workspace";
import {
  createDeleteFileTool,
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
} from "../../../src/ai/tools/files";

interface ExecutableTool {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function exec(tool: unknown, input: Record<string, unknown> = {}) {
  return (tool as ExecutableTool).execute(input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listFiles", () => {
  it("returns human-readable listings", async () => {
    mockList.mockResolvedValue({
      files: [
        {
          path: "inbox/lease.pdf",
          size: 2048,
          mimeType: "application/pdf",
          updatedAt: new Date("2026-06-01T12:00:00Z"),
          source: "chat-upload",
        },
      ],
      count: 1,
      totalBytes: 2048,
    });

    const result = await exec(createListFilesTool(), { prefix: "inbox" });

    expect(mockList).toHaveBeenCalledWith("inbox");
    expect(result).toEqual({
      success: true,
      count: 1,
      totalSize: "2.0 KB",
      files: [
        {
          path: "inbox/lease.pdf",
          size: "2.0 KB",
          mimeType: "application/pdf",
          modified: "2026-06-01T12:00:00.000Z",
        },
      ],
    });
  });

  it("reports infrastructure faults as degraded", async () => {
    mockList.mockRejectedValue(new Error("mongo down"));
    const result = await exec(createListFilesTool());
    expect(result).toMatchObject({ success: false, reason: "mongo down", degraded: true });
  });
});

describe("readFile", () => {
  it("chunks long text files with offset continuation", async () => {
    const text = "x".repeat(4000) + "y".repeat(100);
    mockRead.mockResolvedValue({
      path: "long.txt",
      data: Buffer.from(text),
      mimeType: "text/plain",
      size: text.length,
      updatedAt: new Date(),
    });

    const first = await exec(createReadFileTool(), { path: "long.txt" });
    expect(first).toMatchObject({
      success: true,
      totalChars: 4100,
      offset: 0,
      hasMore: true,
      nextOffset: 4000,
    });
    expect((first.content as string).length).toBe(4000);

    const second = await exec(createReadFileTool(), { path: "long.txt", offset: 4000 });
    expect(second).toMatchObject({ success: true, content: "y".repeat(100), hasMore: false });
    expect(second).not.toHaveProperty("nextOffset");
  });

  it("returns metadata only for binary files", async () => {
    mockRead.mockResolvedValue({
      path: "photo.png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
      mimeType: "image/png",
      size: 5,
      updatedAt: new Date(),
    });

    const result = await exec(createReadFileTool(), { path: "photo.png" });
    expect(result).toMatchObject({ success: true, binary: true, mimeType: "image/png" });
    expect(result).not.toHaveProperty("content");
  });

  it("relays WorkspaceError reasons without the degraded flag", async () => {
    mockRead.mockRejectedValue(new WorkspaceError('no file at "ghost.txt"'));
    const result = await exec(createReadFileTool(), { path: "ghost.txt" });
    expect(result).toEqual({ success: false, reason: 'no file at "ghost.txt"' });
  });
});

describe("writeFile", () => {
  it("writes UTF-8 content with agent provenance", async () => {
    mockWrite.mockResolvedValue({
      path: "drafts/plan.md",
      size: 11,
      mimeType: "text/markdown",
      overwritten: false,
    });

    const result = await exec(createWriteFileTool("chat-42"), {
      path: "drafts/plan.md",
      content: "hello world",
    });

    expect(mockWrite).toHaveBeenCalledWith({
      path: "drafts/plan.md",
      data: Buffer.from("hello world", "utf-8"),
      source: "agent",
      sourceChatId: "chat-42",
      overwrite: undefined,
    });
    expect(result).toEqual({
      success: true,
      path: "drafts/plan.md",
      size: "11 B",
      mimeType: "text/markdown",
      overwritten: false,
    });
  });

  it("relays the occupied-path refusal so the model can read-then-overwrite", async () => {
    mockWrite.mockRejectedValue(
      new WorkspaceError(
        'a file already exists at "drafts/plan.md" (2.0 KB) — pass overwrite to replace it',
      ),
    );
    const result = await exec(createWriteFileTool("chat-42"), {
      path: "drafts/plan.md",
      content: "v2",
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("overwrite");
    expect(result).not.toHaveProperty("degraded");
  });
});

describe("deleteFile", () => {
  it("confirms the move to trash", async () => {
    mockDelete.mockResolvedValue(undefined);
    const result = await exec(createDeleteFileTool(), { path: "old.txt" });
    expect(mockDelete).toHaveBeenCalledWith("old.txt");
    expect(result.success).toBe(true);
    expect(result.note).toContain("trash");
  });

  it("relays a missing-file refusal", async () => {
    mockDelete.mockRejectedValue(new WorkspaceError('no file at "old.txt"'));
    const result = await exec(createDeleteFileTool(), { path: "old.txt" });
    expect(result).toEqual({ success: false, reason: 'no file at "old.txt"' });
  });
});

describe("sendFile", () => {
  it("reads the workspace file and sends it through the adapter", async () => {
    const { fakeAdapter } = await import("@kokoro/test-utils");
    const { createSendFileTool } = await import("../../../src/ai/tools/files");
    mockRead.mockResolvedValue({
      path: "reports/june.csv",
      data: Buffer.from("a,b\n1,2\n"),
      mimeType: "text/csv",
      size: 8,
      updatedAt: new Date(),
    });

    const adapter = fakeAdapter();
    const result = await exec(createSendFileTool("chat-7", adapter), {
      path: "reports/june.csv",
      caption: "june numbers",
    });

    expect(adapter.calls.sendFileBuffer).toEqual([
      {
        chatId: "chat-7",
        bytes: 8,
        fileName: "june.csv",
        mimeType: "text/csv",
        caption: "june numbers",
      },
    ]);
    expect(result).toMatchObject({ success: true, sent: true, fileName: "june.csv", size: "8 B" });
  });

  it("relays a missing-file refusal without sending", async () => {
    const { fakeAdapter } = await import("@kokoro/test-utils");
    const { createSendFileTool } = await import("../../../src/ai/tools/files");
    mockRead.mockRejectedValue(new WorkspaceError('no file at "ghost.csv"'));

    const adapter = fakeAdapter();
    const result = await exec(createSendFileTool("chat-7", adapter), { path: "ghost.csv" });

    expect(adapter.calls.sendFileBuffer).toHaveLength(0);
    expect(result).toEqual({ success: false, reason: 'no file at "ghost.csv"' });
  });
});
