import { withTestDb } from "@mashiro/test-utils";
import { describe, expect, it } from "vitest";

import {
  PendingConfirmation,
  attachResultText,
  createPendingConfirmation,
  getPendingConfirmation,
  listPendingConfirmations,
  resolvePendingConfirmation,
  setPromptMessageId,
} from "../../src/models/pending-confirmation";

withTestDb({ syncIndexes: false });

const baseInput = {
  chatId: "chat-1",
  summary: "send email to alice",
  action: { tool: "sendEmail", args: { to: "alice@example.com" } },
};

describe("createPendingConfirmation", () => {
  it("inserts a row with status=pending, origin=conversation by default", async () => {
    const row = await createPendingConfirmation(baseInput);
    expect(row.status).toBe("pending");
    expect(row.origin).toBe("conversation");
    expect(row.chatId).toBe("chat-1");
    expect(row.action).toEqual({
      tool: "sendEmail",
      args: { to: "alice@example.com" },
    });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it("defaults expiresAt to ~24 h from now when ttlMs is omitted", async () => {
    const before = Date.now();
    const row = await createPendingConfirmation(baseInput);
    const ttl = row.expiresAt.getTime() - before;
    // 24 h ± 1 s tolerance.
    expect(ttl).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000);
    expect(ttl).toBeLessThan(24 * 60 * 60 * 1000 + 1000);
  });

  it("respects an explicit ttlMs", async () => {
    const before = Date.now();
    const row = await createPendingConfirmation({ ...baseInput, ttlMs: 60_000 });
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(59_000);
    expect(ttl).toBeLessThan(61_000);
  });

  it("accepts every PendingConfirmationOrigin value", async () => {
    for (const origin of ["conversation", "routine", "watcher"] as const) {
      const row = await createPendingConfirmation({ ...baseInput, origin });
      expect(row.origin).toBe(origin);
    }
  });
});

describe("getPendingConfirmation", () => {
  it("returns the row by id", async () => {
    const created = await createPendingConfirmation(baseInput);
    const fetched = await getPendingConfirmation(created.id as string);
    expect(fetched?.id).toBe(created.id);
  });

  it("returns null for a non-existent id", async () => {
    // Valid ObjectId shape, but not present in the collection.
    const result = await getPendingConfirmation("000000000000000000000000");
    expect(result).toBeNull();
  });
});

describe("setPromptMessageId", () => {
  it("patches the promptMessageId on an existing row", async () => {
    const row = await createPendingConfirmation(baseInput);
    await setPromptMessageId(row.id as string, "tg-msg-42");
    const reread = await getPendingConfirmation(row.id as string);
    expect(reread?.promptMessageId).toBe("tg-msg-42");
  });
});

describe("resolvePendingConfirmation — atomicity", () => {
  it("transitions pending → approved on first call, returns the updated row", async () => {
    const row = await createPendingConfirmation(baseInput);
    const result = await resolvePendingConfirmation(row.id as string, "approved");
    expect(result?.status).toBe("approved");
    expect(result?.resolvedAt).toBeInstanceOf(Date);
  });

  it("returns null on a second resolution attempt (already-resolved row)", async () => {
    const row = await createPendingConfirmation(baseInput);
    await resolvePendingConfirmation(row.id as string, "approved");
    const second = await resolvePendingConfirmation(row.id as string, "denied");
    expect(second).toBeNull();
  });

  it("is race-safe under concurrent resolution attempts — exactly one wins", async () => {
    const row = await createPendingConfirmation(baseInput);
    const id = row.id as string;
    // Fire 5 concurrent resolutions in opposite directions; only one should
    // come back non-null. The findOneAndUpdate filter `{ status: "pending" }`
    // is the atomic-CAS that gates this.
    const verdicts = ["approved", "denied", "cancelled", "approved", "denied"] as const;
    const results = await Promise.all(verdicts.map((v) => resolvePendingConfirmation(id, v)));
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0].status).toBe(winners[0].status); // tautology — just pinning the shape
    // The persisted row should match the single winner's verdict.
    const persisted = await getPendingConfirmation(id);
    expect(persisted?.status).toBe(winners[0].status);
  });

  it("returns null for a non-existent id", async () => {
    const result = await resolvePendingConfirmation("000000000000000000000000", "approved");
    expect(result).toBeNull();
  });

  it("writes resultText when supplied alongside the verdict", async () => {
    const row = await createPendingConfirmation(baseInput);
    const result = await resolvePendingConfirmation(
      row.id as string,
      "approved",
      "email sent to alice@example.com",
    );
    expect(result?.resultText).toBe("email sent to alice@example.com");
  });

  it("leaves resultText untouched when verdict is supplied without it", async () => {
    const row = await createPendingConfirmation(baseInput);
    await attachResultText(row.id as string, "earlier note");
    // Reset status to pending to test the resolve-without-resultText branch.
    await PendingConfirmation.findByIdAndUpdate(row.id as string, { status: "pending" });
    await resolvePendingConfirmation(row.id as string, "approved");
    const reread = await getPendingConfirmation(row.id as string);
    expect(reread?.resultText).toBe("earlier note");
  });

  it("accepts each terminal verdict value", async () => {
    for (const verdict of ["approved", "denied", "cancelled", "expired"] as const) {
      const row = await createPendingConfirmation(baseInput);
      const result = await resolvePendingConfirmation(row.id as string, verdict);
      expect(result?.status).toBe(verdict);
    }
  });
});

describe("listPendingConfirmations", () => {
  it("returns only rows that are still pending and not expired, oldest first", async () => {
    // Successive create() calls can land on the same millisecond, which
    // makes the createdAt ordering ambiguous. Backdate the earlier rows
    // explicitly so the sort is deterministic.
    const a = await createPendingConfirmation({ ...baseInput, summary: "first" });
    await PendingConfirmation.collection.updateOne(
      { _id: a._id },
      { $set: { createdAt: new Date(Date.now() - 2000) } },
    );
    const b = await createPendingConfirmation({ ...baseInput, summary: "second" });
    await PendingConfirmation.collection.updateOne(
      { _id: b._id },
      { $set: { createdAt: new Date(Date.now() - 1000) } },
    );
    const c = await createPendingConfirmation({ ...baseInput, summary: "third" });
    // Resolve `b` so it shouldn't appear in the list.
    await resolvePendingConfirmation(b.id as string, "approved");

    const rows = await listPendingConfirmations("chat-1");
    expect(rows.map((r) => r.summary)).toEqual(["first", "third"]);
    expect(rows[0].id).toBe(a.id);
    expect(rows[1].id).toBe(c.id);
  });

  it("scopes results to the requested chatId", async () => {
    await createPendingConfirmation({ ...baseInput, chatId: "chat-1" });
    await createPendingConfirmation({ ...baseInput, chatId: "chat-2" });
    const rows = await listPendingConfirmations("chat-2");
    expect(rows).toHaveLength(1);
    expect(rows[0].chatId).toBe("chat-2");
  });

  it("excludes rows whose expiresAt has already passed", async () => {
    await createPendingConfirmation({ ...baseInput, ttlMs: -1000 });
    const rows = await listPendingConfirmations("chat-1");
    expect(rows).toHaveLength(0);
  });

  it("returns [] when the chat has no pending rows", async () => {
    const rows = await listPendingConfirmations("nobody-here");
    expect(rows).toEqual([]);
  });
});

describe("attachResultText", () => {
  it("patches resultText without changing status", async () => {
    const row = await createPendingConfirmation(baseInput);
    await resolvePendingConfirmation(row.id as string, "approved");
    await attachResultText(row.id as string, "after-the-fact note");
    const reread = await getPendingConfirmation(row.id as string);
    expect(reread?.resultText).toBe("after-the-fact note");
    expect(reread?.status).toBe("approved");
  });
});
