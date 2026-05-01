import { deterministicEmbedding, withTestDb } from "@mashiro/test-utils";
import { describe, expect, it, vi } from "vitest";

// Silence the Pino logger so memory-store info logs don't leak into test output.
vi.mock("@mashiro/shared", async (orig) => ({
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

// Stub generateEmbedding so tests don't reach Google. cosineSimilarity is the
// real implementation — we want recall ranking to use the real math.
vi.mock("../src/embedding", async () => {
  const real = await vi.importActual<typeof import("../src/embedding")>("../src/embedding");
  const generateEmbedding = (text: string): Promise<number[]> =>
    Promise.resolve(deterministicEmbedding(text, 32));
  return { cosineSimilarity: real.cosineSimilarity, generateEmbedding };
});

import { Memory } from "@mashiro/db";

import {
  archiveMany,
  archiveMemory,
  clearWorkingMemories,
  forget,
  getActiveFollowUps,
  getActiveFollowUpsWithIds,
  getEmotionalBaseline,
  getEpisodesBefore,
  getFactCount,
  getFactsByRelevance,
  getRecentDailyEpisodes,
  getRecentMilestones,
  getRecentWeeklyEpisodes,
  getTopFacts,
  getWorkingMemories,
  recall,
  remember,
  resolveFollowUp,
  setWorkingMemory,
} from "../src/engine";

withTestDb({ syncIndexes: false });

describe("remember", () => {
  it("persists content with the deterministic embedding and timestamps", async () => {
    const m = await remember("Eric prefers oat milk", "fact", "user-said", {
      chatId: "chat-1",
      importance: 7,
    });
    expect(m.content).toBe("Eric prefers oat milk");
    expect(m.type).toBe("fact");
    expect(m.embedding.length).toBe(32);
    expect(m.metadata.createdAt).toBeInstanceOf(Date);
    expect(m.metadata.importance).toBe(7);
    expect(m.metadata.chatId).toBe("chat-1");
  });

  it("stores followUps and emotionalTone when provided", async () => {
    const m = await remember("had a hard day", "episode", "session-summary", {
      emotionalTone: 2,
      followUps: ["check in tomorrow"],
      sessionId: "s1",
    });
    expect(m.metadata.emotionalTone).toBe(2);
    expect(m.metadata.followUps).toEqual(["check in tomorrow"]);
    expect(m.metadata.sessionId).toBe("s1");
  });
});

describe("recall — composite scoring + filters", () => {
  it("ranks more-similar content above less-similar", async () => {
    await remember("the cat sat on the mat", "fact", "test");
    await remember("financial reporting requirements for Q3", "fact", "test");

    const results = await recall("cat on a mat");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe("the cat sat on the mat");
  });

  it("filters by type when opts.type is set", async () => {
    await remember("a fact about cats", "fact", "test");
    await remember("an episode about cats", "episode", "test");
    await remember("a milestone about cats", "milestone", "test");

    const facts = await recall("cats", { type: "fact", minScore: 0 });
    expect(facts.every((r) => r.type === "fact")).toBe(true);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("excludes archived memories from recall", async () => {
    const archived = await remember("archived fact about cats", "fact", "test");
    await remember("live fact about cats", "fact", "test");
    await archiveMemory(archived.id as string);

    const results = await recall("cats", { minScore: 0 });
    expect(results.find((r) => r.content === "archived fact about cats")).toBeUndefined();
    expect(results.find((r) => r.content === "live fact about cats")).toBeDefined();
  });

  it("respects minScore — irrelevant content below threshold is excluded", async () => {
    await remember("aardvarks dig holes", "fact", "test");
    const results = await recall("photosynthesis", { minScore: 0.99 });
    expect(results).toEqual([]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await remember(`fact about cats number ${String(i)}`, "fact", "test");
    }
    const results = await recall("cats", { limit: 2, minScore: 0 });
    expect(results).toHaveLength(2);
  });

  it("excludes working memories regardless of type filter", async () => {
    await setWorkingMemory("note about cats", "session-1");
    await remember("real fact about cats", "fact", "test");

    const results = await recall("cats", { minScore: 0 });
    expect(results.every((r) => r.type !== "working")).toBe(true);
  });
});

describe("forget", () => {
  it("returns true when removed, false when missing", async () => {
    const m = await remember("temp", "fact", "test");
    expect(await forget(m.id as string)).toBe(true);
    expect(await Memory.findById(m._id)).toBeNull();
    expect(await forget("000000000000000000000000")).toBe(false);
  });
});

describe("episode retrieval split by source", () => {
  it("getRecentDailyEpisodes excludes weekly-merge and monthly-consolidation", async () => {
    await remember("daily entry", "episode", "session-summary");
    await remember("weekly summary", "episode", "weekly-merge");
    await remember("monthly recap", "episode", "monthly-consolidation");

    const daily = await getRecentDailyEpisodes(10);
    expect(daily.map((e) => e.source)).toEqual(["session-summary"]);
  });

  it("getRecentWeeklyEpisodes returns only weekly-merge", async () => {
    await remember("daily entry", "episode", "session-summary");
    await remember("weekly summary", "episode", "weekly-merge");

    const weekly = await getRecentWeeklyEpisodes(10);
    expect(weekly).toHaveLength(1);
    expect(weekly[0].source).toBe("weekly-merge");
  });

  it("getEpisodesBefore filters by metadata.createdAt", async () => {
    const old = await remember("old episode", "episode", "session-summary");
    const recent = await remember("recent episode", "episode", "session-summary");
    // Backdate `old` by 10 days.
    await Memory.collection.updateOne(
      { _id: old._id },
      {
        $set: {
          "metadata.createdAt": new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        },
      },
    );

    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const olderThan = await getEpisodesBefore(cutoff);
    expect(olderThan.map((e) => e.id as string)).toEqual([old.id]);
    expect(olderThan.map((e) => e.id as string)).not.toContain(recent.id);
  });

  it("getEpisodesBefore honours excludeSources", async () => {
    const old = await remember("old daily", "episode", "session-summary");
    const oldWeekly = await remember("old weekly", "episode", "weekly-merge");
    await Memory.collection.updateMany(
      { _id: { $in: [old._id, oldWeekly._id] } },
      { $set: { "metadata.createdAt": new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } },
    );

    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const result = await getEpisodesBefore(cutoff, ["weekly-merge"]);
    expect(result.map((e) => e.source)).toEqual(["session-summary"]);
  });
});

describe("fact retrieval", () => {
  it("getTopFacts ranks by importance desc, then createdAt desc, respects limit", async () => {
    const low = await remember("low-importance", "fact", "test", { importance: 2 });
    const high = await remember("high-importance", "fact", "test", { importance: 9 });
    const mid = await remember("mid-importance", "fact", "test", { importance: 5 });

    const facts = await getTopFacts(10);
    expect(facts.map((f) => f.id as string)).toEqual([high.id, mid.id, low.id]);
  });

  it("getTopFacts excludes archived", async () => {
    const a = await remember("a", "fact", "test", { importance: 5 });
    await archiveMemory(a.id as string);
    expect(await getTopFacts(10)).toHaveLength(0);
  });

  it("getFactsByRelevance ranks by cosine similarity", async () => {
    await remember("cats are mammals", "fact", "test");
    await remember("databases use indexes", "fact", "test");
    const out = await getFactsByRelevance("cats");
    expect(out[0].content).toBe("cats are mammals");
  });

  it("getFactCount counts only non-archived facts", async () => {
    const live = await remember("live", "fact", "test");
    const arch = await remember("arch", "fact", "test");
    await archiveMemory(arch.id as string);
    void live;
    expect(await getFactCount()).toBe(1);
  });
});

describe("milestones", () => {
  it("getRecentMilestones returns newest-first, respects limit", async () => {
    const a = await remember("first milestone", "milestone", "test");
    // backdate
    await Memory.collection.updateOne(
      { _id: a._id },
      { $set: { "metadata.createdAt": new Date(Date.now() - 10_000) } },
    );
    const b = await remember("second milestone", "milestone", "test");

    const out = await getRecentMilestones(10);
    expect(out.map((m) => m.id as string)).toEqual([b.id, a.id]);
  });
});

describe("follow-ups", () => {
  it("getActiveFollowUps returns deduped recent items, lowercased-key match", async () => {
    await remember("ep1", "episode", "test", {
      followUps: ["Check in with Alice", "buy milk"],
    });
    await remember("ep2", "episode", "test", {
      followUps: ["check in with alice", "ship docs"],
    });

    const out = await getActiveFollowUps(10);
    expect(out).toHaveLength(3);
    // First-seen casing wins (note ordering is newest-first by createdAt).
    expect(out).toContain("buy milk");
    expect(out).toContain("ship docs");
    expect(out.some((f) => f.toLowerCase() === "check in with alice")).toBe(true);
  });

  it("getActiveFollowUps excludes items older than maxAgeDays", async () => {
    const old = await remember("ep-old", "episode", "test", { followUps: ["old"] });
    const recent = await remember("ep-recent", "episode", "test", { followUps: ["recent"] });
    await Memory.collection.updateOne(
      { _id: old._id },
      { $set: { "metadata.createdAt": new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } },
    );
    void recent;

    expect(await getActiveFollowUps(10, 30)).toEqual(["recent"]);
  });

  it("getActiveFollowUpsWithIds returns memoryId references", async () => {
    const m = await remember("ep", "episode", "test", { followUps: ["task A"] });
    const out = await getActiveFollowUpsWithIds(10);
    expect(out).toEqual([{ memoryId: m._id?.toString(), text: "task A" }]);
  });

  it("resolveFollowUp pulls the matching string from the metadata array", async () => {
    const m = await remember("ep", "episode", "test", { followUps: ["a", "b"] });
    await resolveFollowUp(m.id as string, "a");
    const reread = await Memory.findById(m._id);
    expect(reread?.metadata.followUps).toEqual(["b"]);
  });
});

describe("working memory", () => {
  it("setWorkingMemory persists with type=working and an expiresAt", async () => {
    const m = await setWorkingMemory("scratchpad", "session-1", 1);
    expect(m.type).toBe("working");
    expect(m.metadata.sessionId).toBe("session-1");
    expect(m.metadata.expiresAt).toBeInstanceOf(Date);
  });

  it("getWorkingMemories scopes by sessionId", async () => {
    await setWorkingMemory("note-a", "session-1");
    await setWorkingMemory("note-b", "session-2");
    const a = await getWorkingMemories("session-1");
    expect(a.map((m) => m.content)).toEqual(["note-a"]);
  });

  it("clearWorkingMemories removes only the given session's notes", async () => {
    await setWorkingMemory("note-a", "session-1");
    await setWorkingMemory("note-b", "session-2");
    await clearWorkingMemories("session-1");
    expect(await getWorkingMemories("session-1")).toEqual([]);
    expect(await getWorkingMemories("session-2")).toHaveLength(1);
  });
});

describe("archiveMany", () => {
  it("flips archivedAt on every supplied id and records mergedInto", async () => {
    const a = await remember("a", "fact", "test");
    const b = await remember("b", "fact", "test");
    const target = await remember("target", "fact", "test");
    await archiveMany([a.id as string, b.id as string], target.id as string);

    const reA = await Memory.findById(a._id);
    const reB = await Memory.findById(b._id);
    expect(reA?.metadata.archivedAt).toBeInstanceOf(Date);
    expect(reB?.metadata.archivedAt).toBeInstanceOf(Date);
    expect(reA?.metadata.mergedInto).toBe(target.id);
    expect(reB?.metadata.mergedInto).toBe(target.id);
  });
});

describe("getEmotionalBaseline", () => {
  it("returns null when fewer than MIN_BASELINE_POINTS scored episodes exist", async () => {
    await remember("ep", "episode", "test", { emotionalTone: 5 });
    expect(await getEmotionalBaseline(10)).toBeNull();
  });

  it('reports trend="rising" when recent episodes score noticeably higher than older', async () => {
    // Insert older low-tone episodes first, then recent high-tone.
    const olderTones = [3, 3, 3];
    const recentTones = [8, 8, 8];
    for (const tone of olderTones) {
      const m = await remember("older", "episode", "test", { emotionalTone: tone });
      await Memory.collection.updateOne(
        { _id: m._id },
        { $set: { "metadata.createdAt": new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } },
      );
    }
    for (const tone of recentTones) {
      await remember("recent", "episode", "test", { emotionalTone: tone });
    }

    const baseline = await getEmotionalBaseline(10);
    expect(baseline).not.toBeNull();
    expect(baseline!.trend).toBe("rising");
  });

  it('reports trend="stable" when scores are flat across the window', async () => {
    for (let i = 0; i < 5; i++) {
      await remember(`flat-${String(i)}`, "episode", "test", { emotionalTone: 5 });
    }
    const baseline = await getEmotionalBaseline(10);
    expect(baseline?.trend).toBe("stable");
  });
});
