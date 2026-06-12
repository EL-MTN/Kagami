import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pin quotas so the sync-back quota test is environment-independent.
vi.mock("@kokoro/shared", async (orig) => {
  const real = await orig<typeof import("@kokoro/shared")>();
  return {
    ...real,
    config: {
      ...real.config,
      WORKSPACE_MAX_FILE_MB: 1,
      WORKSPACE_MAX_TOTAL_MB: 64,
      WORKSPACE_MAX_FILES: 100,
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
  mockSoftDelete,
  mockUpsert,
  mockWriteBlob,
  mockRemoveBlob,
} = vi.hoisted(() => ({
  mockGetByPath: vi.fn(),
  mockGetTotals: vi.fn(),
  mockListFiles: vi.fn(),
  mockReadBlob: vi.fn(),
  mockSoftDelete: vi.fn(),
  mockUpsert: vi.fn(),
  mockWriteBlob: vi.fn(),
  mockRemoveBlob: vi.fn(),
}));

vi.mock("@kokoro/db", () => ({
  generateWorkspaceKey: () => "fresh-key",
  getWorkspaceFileByPath: mockGetByPath,
  getWorkspaceTotals: mockGetTotals,
  isDuplicateKeyError: (e: unknown) =>
    e instanceof Error && "code" in e && (e as { code?: unknown }).code === 11000,
  listWorkspaceFiles: mockListFiles,
  readWorkspaceBlob: mockReadBlob,
  removeWorkspaceBlob: mockRemoveBlob,
  softDeleteWorkspaceFile: mockSoftDelete,
  upsertWorkspaceFile: mockUpsert,
  writeWorkspaceBlob: mockWriteBlob,
}));

import {
  cleanupWorkspaceDir,
  formatWorkspaceDelta,
  materializeWorkspace,
  syncBackWorkspace,
  withWorkspaceSandboxLock,
} from "../../src/services/workspace-sandbox";

const MB = 1024 * 1024;

function row(path: string, gridfsKey = `key-${path}`, size = 10) {
  return {
    path,
    gridfsKey,
    size,
    mimeType: "text/plain",
    source: "agent",
    sourceChatId: null,
    updatedAt: new Date(),
  };
}

const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockListFiles.mockResolvedValue([]);
  mockGetByPath.mockResolvedValue(null);
  mockGetTotals.mockResolvedValue({ count: 0, totalBytes: 0 });
  mockUpsert.mockResolvedValue({ previousGridfsKey: null });
  mockSoftDelete.mockImplementation((path: string) => Promise.resolve(row(path)));
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function materialized() {
  const m = await materializeWorkspace();
  tempDirs.push(m.dir);
  return m;
}

describe("materializeWorkspace", () => {
  it("copies live files (nested paths included) and records content hashes", async () => {
    mockListFiles.mockResolvedValue([row("a.txt"), row("reports/2026/june.csv")]);
    mockReadBlob.mockImplementation((key: string) =>
      Promise.resolve({ data: Buffer.from(`content of ${key}`), mimeType: "text/plain" }),
    );

    const m = await materialized();

    expect((await readFile(nodePath.join(m.dir, "a.txt"))).toString()).toBe("content of key-a.txt");
    expect((await readFile(nodePath.join(m.dir, "reports/2026/june.csv"))).toString()).toBe(
      "content of key-reports/2026/june.csv",
    );
    expect([...m.manifest.keys()].sort()).toEqual(["a.txt", "reports/2026/june.csv"]);
  });

  it("skips rows whose blob is missing instead of failing the run", async () => {
    mockListFiles.mockResolvedValue([row("ok.txt"), row("torn.txt")]);
    mockReadBlob.mockImplementation((key: string) =>
      key === "key-torn.txt"
        ? Promise.resolve(null)
        : Promise.resolve({ data: Buffer.from("fine"), mimeType: "text/plain" }),
    );

    const m = await materialized();

    expect([...m.manifest.keys()]).toEqual(["ok.txt"]);
  });
});

describe("syncBackWorkspace", () => {
  it("classifies added, modified, unchanged, and deleted files", async () => {
    mockListFiles.mockResolvedValue([row("keep.txt"), row("edit.txt"), row("gone.txt")]);
    mockReadBlob.mockImplementation((key: string) =>
      Promise.resolve({ data: Buffer.from(`v1 ${key}`), mimeType: "text/plain" }),
    );
    const m = await materialized();

    // Simulate the run: create one, edit one, delete one, leave one alone.
    await writeFile(nodePath.join(m.dir, "new.txt"), "fresh");
    await writeFile(nodePath.join(m.dir, "edit.txt"), "v2");
    await rm(nodePath.join(m.dir, "gone.txt"));

    const delta = await syncBackWorkspace(m);

    expect(delta.added.map((f) => f.path)).toEqual(["new.txt"]);
    expect(delta.modified.map((f) => f.path)).toEqual(["edit.txt"]);
    expect(delta.deleted).toEqual(["gone.txt"]);
    expect(delta.skipped).toEqual([]);

    // Unchanged file → zero writes for it; upsert ran only for new + edit.
    const writtenPaths = mockUpsert.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(writtenPaths.sort()).toEqual(["edit.txt", "new.txt"]);
    // Sandbox provenance on everything synced back.
    for (const call of mockUpsert.mock.calls) {
      expect((call[0] as { source: string }).source).toBe("sandbox");
    }
    expect(mockSoftDelete).toHaveBeenCalledWith("gone.txt");
  });

  it("skips non-regular files (symlinks) and reports them", async () => {
    const m = await materialized();
    await writeFile(nodePath.join(m.dir, "real.txt"), "data");
    await symlink("/etc/passwd", nodePath.join(m.dir, "sneaky"));

    const delta = await syncBackWorkspace(m);

    expect(delta.added.map((f) => f.path)).toEqual(["real.txt"]);
    expect(delta.skipped).toEqual([{ path: "sneaky", reason: "not a regular file" }]);
  });

  it("routes per-file quota violations into skipped with the policy reason", async () => {
    const m = await materialized();
    await writeFile(nodePath.join(m.dir, "huge.bin"), Buffer.alloc(MB + 1));
    await writeFile(nodePath.join(m.dir, "small.txt"), "ok");

    const delta = await syncBackWorkspace(m);

    expect(delta.added.map((f) => f.path)).toEqual(["small.txt"]);
    expect(delta.skipped).toHaveLength(1);
    expect(delta.skipped[0].path).toBe("huge.bin");
    expect(delta.skipped[0].reason).toContain("per-file cap");
  });
});

describe("withWorkspaceSandboxLock", () => {
  it("serializes concurrent workspace runs", async () => {
    const order: string[] = [];
    const slow = withWorkspaceSandboxLock(async () => {
      order.push("slow:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow:end");
    });
    const fast = withWorkspaceSandboxLock(() => {
      order.push("fast:start");
      return Promise.resolve();
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow:start", "slow:end", "fast:start"]);
  });

  it("keeps the chain alive after a rejected run", async () => {
    await expect(withWorkspaceSandboxLock(() => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(withWorkspaceSandboxLock(() => Promise.resolve("next"))).resolves.toBe("next");
  });
});

describe("formatWorkspaceDelta", () => {
  it("returns null for a no-op delta", () => {
    expect(formatWorkspaceDelta({ added: [], modified: [], deleted: [], skipped: [] })).toBeNull();
  });

  it("renders all four classes compactly", () => {
    const line = formatWorkspaceDelta({
      added: [{ path: "out.csv", size: 12_288 }],
      modified: [{ path: "data.json", size: 5 }],
      deleted: ["old.txt"],
      skipped: [{ path: "huge.bin", reason: "per-file cap" }],
    });
    expect(line).toBe(
      "wrote out.csv (12.0 KB); modified data.json; deleted old.txt; skipped huge.bin (per-file cap)",
    );
  });

  it("caps each category at five paths and reports the remainder", () => {
    const added = Array.from({ length: 8 }, (_, i) => ({ path: `out/f${i}.txt`, size: 10 }));
    const deleted = Array.from({ length: 7 }, (_, i) => `gone/g${i}.txt`);
    const line = formatWorkspaceDelta({ added, modified: [], deleted, skipped: [] })!;
    // First five of each category appear; the rest collapse to a count —
    // the summary feeds a chat message edit AND the next LLM context.
    expect(line).toContain("out/f4.txt");
    expect(line).not.toContain("out/f5.txt");
    expect(line).toContain("+3 more");
    expect(line).toContain("gone/g4.txt");
    expect(line).not.toContain("gone/g5.txt");
    expect(line).toContain("+2 more");
  });
});

describe("cleanupWorkspaceDir", () => {
  it("removes the directory and tolerates a second call", async () => {
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "kokoro-ws-test-"));
    await writeFile(nodePath.join(dir, "f.txt"), "x");

    await cleanupWorkspaceDir(dir);
    await cleanupWorkspaceDir(dir); // force:true → no throw on missing

    await expect(readFile(nodePath.join(dir, "f.txt"))).rejects.toThrow();
  });
});

describe("syncBackWorkspace — robustness", () => {
  it("matches a manifest key across NFC/NFD normalization (mount returns NFD)", async () => {
    // Materialize keys by NFC; simulate a mount that hands the name back in NFD.
    const nfc = "café.txt".normalize("NFC");
    mockListFiles.mockResolvedValue([row(nfc)]);
    mockReadBlob.mockResolvedValue({ data: Buffer.from("body"), mimeType: "text/plain" });
    const m = await materialized();

    // Rewrite the file under the NFD name (what a VirtioFS readback can yield),
    // removing the NFC original so only the NFD form is on disk.
    const nfd = "café.txt".normalize("NFD");
    await rm(nodePath.join(m.dir, nfc));
    await writeFile(nodePath.join(m.dir, nfd), "body");

    const delta = await syncBackWorkspace(m);

    // Same bytes + NFC-folded key → recognized as unchanged, NOT deleted+re-added.
    expect(delta.added).toEqual([]);
    expect(delta.modified).toEqual([]);
    expect(delta.deleted).toEqual([]);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("syncs a legitimate delete-all: empty but readable run dir deletes every file", async () => {
    mockListFiles.mockResolvedValue([row("a.txt"), row("b.txt")]);
    mockReadBlob.mockResolvedValue({ data: Buffer.from("x"), mimeType: "text/plain" });
    const m = await materialized();

    // The user-approved code removed everything (rm -rf /workspace/*). An
    // empty-but-traversable dir is a real deletion, not a mount fault.
    await rm(nodePath.join(m.dir, "a.txt"));
    await rm(nodePath.join(m.dir, "b.txt"));

    const delta = await syncBackWorkspace(m);

    expect([...delta.deleted].sort()).toEqual(["a.txt", "b.txt"]);
    expect(mockSoftDelete).toHaveBeenCalledTimes(2);
    expect(delta.skipped).toEqual([]);
  });

  it("refuses to mass-delete when the run dir itself is unreadable", async () => {
    mockListFiles.mockResolvedValue([row("a.txt"), row("b.txt")]);
    mockReadBlob.mockResolvedValue({ data: Buffer.from("x"), mimeType: "text/plain" });
    const m = await materialized();

    // The fault signal: the directory is GONE (vanished tmpdir, disk
    // fault) — readdir throws, and the sync is skipped wholesale.
    await rm(m.dir, { recursive: true, force: true });

    const delta = await syncBackWorkspace(m);

    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(delta.deleted).toEqual([]);
    expect(delta.skipped).toEqual([
      { path: "(all)", reason: "run directory unreadable; sync skipped" },
    ]);
  });

  it("size-gates via stat before reading — a sparse multi-GB file is skipped cheaply", async () => {
    const m = await materialized();
    const sparse = nodePath.join(m.dir, "sparse.bin");
    await writeFile(sparse, "");
    // Logical size far over the per-file cap with no disk allocation —
    // the stat gate must skip it without buffering it into memory.
    await truncate(sparse, 100 * MB);

    const delta = await syncBackWorkspace(m);

    expect(delta.added).toEqual([]);
    expect(delta.skipped).toHaveLength(1);
    expect(delta.skipped[0].path).toBe("sparse.bin");
    expect(delta.skipped[0].reason).toContain("per-file cap");
  });
});
