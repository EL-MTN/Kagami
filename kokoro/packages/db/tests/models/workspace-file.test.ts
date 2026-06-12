import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  WorkspaceFile,
  getWorkspaceFileByPath,
  getWorkspaceTotals,
  listWorkspaceFiles,
  purgeDeletedWorkspaceFiles,
  softDeleteWorkspaceFile,
  upsertWorkspaceFile,
} from "../../src/models/workspace-file";
import { generateWorkspaceKey, readWorkspaceBlob, writeWorkspaceBlob } from "../../src/gridfs";

withTestDb();

function input(path: string, overrides: Partial<Parameters<typeof upsertWorkspaceFile>[0]> = {}) {
  return {
    path,
    gridfsKey: generateWorkspaceKey(),
    size: 100,
    mimeType: "text/plain",
    source: "agent" as const,
    sourceChatId: "chat-1",
    ...overrides,
  };
}

describe("upsertWorkspaceFile", () => {
  it("mustCreate is insert-only: a concurrent same-path row raises duplicate-key instead of being clobbered", async () => {
    await upsertWorkspaceFile(input("race.txt", { gridfsKey: "first-writer" }));

    // A second writer that checked existence before the first landed must
    // NOT silently match-and-update the row via the upsert form.
    await expect(
      upsertWorkspaceFile(input("race.txt", { gridfsKey: "second-writer" }), {
        mustCreate: true,
      }),
    ).rejects.toMatchObject({ code: 11000 });

    const row = await getWorkspaceFileByPath("race.txt");
    expect(row!.gridfsKey).toBe("first-writer");
  });

  it("creates a fresh file and reports no previous generation", async () => {
    const { previousGridfsKey } = await upsertWorkspaceFile(input("notes.md"));
    expect(previousGridfsKey).toBeNull();

    const row = await getWorkspaceFileByPath("notes.md");
    expect(row).not.toBeNull();
    expect(row!.size).toBe(100);
    expect(row!.source).toBe("agent");
    expect(row!.sourceChatId).toBe("chat-1");
    expect(row!.deletedAt).toBeNull();
  });

  it("overwrites in place and returns the replaced generation's key", async () => {
    const first = input("notes.md", { gridfsKey: "key-v1" });
    await upsertWorkspaceFile(first);

    const { previousGridfsKey } = await upsertWorkspaceFile(
      input("notes.md", { gridfsKey: "key-v2", size: 250, mimeType: "text/markdown" }),
    );
    expect(previousGridfsKey).toBe("key-v1");

    const rows = await listWorkspaceFiles();
    expect(rows).toHaveLength(1);
    expect(rows[0].gridfsKey).toBe("key-v2");
    expect(rows[0].size).toBe(250);
    expect(rows[0].mimeType).toBe("text/markdown");
  });
});

describe("trash semantics", () => {
  it("soft delete hides the file from live reads and listings", async () => {
    await upsertWorkspaceFile(input("old.txt"));
    const deleted = await softDeleteWorkspaceFile("old.txt");
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedAt).not.toBeNull();

    expect(await getWorkspaceFileByPath("old.txt")).toBeNull();
    expect(await listWorkspaceFiles()).toHaveLength(0);
  });

  it("returns null when soft-deleting a path with no live file", async () => {
    expect(await softDeleteWorkspaceFile("missing.txt")).toBeNull();
  });

  it("allows re-creating a path whose predecessor is in trash", async () => {
    await upsertWorkspaceFile(input("report.csv"));
    await softDeleteWorkspaceFile("report.csv");

    // Partial unique index: uniqueness applies to live rows only, so trash can
    // hold prior generations of the same path alongside a new live file.
    const { previousGridfsKey } = await upsertWorkspaceFile(input("report.csv"));
    expect(previousGridfsKey).toBeNull();
    await softDeleteWorkspaceFile("report.csv");
    await upsertWorkspaceFile(input("report.csv"));

    const all = await WorkspaceFile.find({ path: "report.csv" });
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.deletedAt === null)).toHaveLength(1);
  });
});

describe("getWorkspaceTotals", () => {
  it("returns zeros for an empty workspace", async () => {
    expect(await getWorkspaceTotals()).toEqual({ count: 0, totalBytes: 0 });
  });

  it("counts live files only", async () => {
    await upsertWorkspaceFile(input("a.txt", { size: 10 }));
    await upsertWorkspaceFile(input("b.txt", { size: 30 }));
    await upsertWorkspaceFile(input("c.txt", { size: 60 }));
    await softDeleteWorkspaceFile("c.txt");

    expect(await getWorkspaceTotals()).toEqual({ count: 2, totalBytes: 40 });
  });
});

describe("purgeDeletedWorkspaceFiles", () => {
  it("removes expired trash rows and their blobs, sparing live files", async () => {
    const trashedKey = generateWorkspaceKey();
    const liveKey = generateWorkspaceKey();
    await writeWorkspaceBlob(trashedKey, Buffer.from("old bytes"), "text/plain");
    await writeWorkspaceBlob(liveKey, Buffer.from("live bytes"), "text/plain");
    await upsertWorkspaceFile(input("doomed.txt", { gridfsKey: trashedKey }));
    await upsertWorkspaceFile(input("kept.txt", { gridfsKey: liveKey }));
    await softDeleteWorkspaceFile("doomed.txt");

    // olderThanDays: 0 → cutoff is now, so the just-trashed row qualifies.
    const purged = await purgeDeletedWorkspaceFiles(0);
    expect(purged).toBe(1);

    expect(await WorkspaceFile.find({ path: "doomed.txt" })).toHaveLength(0);
    expect(await readWorkspaceBlob(trashedKey)).toBeNull();
    expect(await readWorkspaceBlob(liveKey)).not.toBeNull();
    expect(await getWorkspaceFileByPath("kept.txt")).not.toBeNull();
  });

  it("spares trash younger than the retention window", async () => {
    await upsertWorkspaceFile(input("recent.txt"));
    await softDeleteWorkspaceFile("recent.txt");

    expect(await purgeDeletedWorkspaceFiles(30)).toBe(0);
    expect(await WorkspaceFile.find({ path: "recent.txt" })).toHaveLength(1);
  });
});
