import { Memory, type IMemory } from "@mashiro/db";
import { generateEmbedding, cosineSimilarity } from "./embedding";
import { logger } from "@mashiro/shared";

export interface RememberOptions {
  chatId?: string;
  emotionalTone?: number;
  importance?: number;
  followUps?: string[];
  sessionId?: string;
}

export interface RecallOptions {
  type?: "fact" | "episode" | "milestone";
  limit?: number;
  minScore?: number;
}

export interface RecallResult {
  id: string;
  content: string;
  type: string;
  score: number;
  metadata: IMemory["metadata"];
}

// ---------------------------------------------------------------------------
// Core: remember / recall / forget
// ---------------------------------------------------------------------------

export async function remember(
  content: string,
  type: "fact" | "episode" | "milestone",
  source: string,
  options: RememberOptions = {},
): Promise<IMemory> {
  const embedding = await generateEmbedding(content);
  const now = new Date();

  const memory = await Memory.create({
    content,
    type,
    source,
    embedding,
    metadata: {
      chatId: options.chatId,
      emotionalTone: options.emotionalTone,
      importance: options.importance,
      followUps: options.followUps,
      sessionId: options.sessionId,
      createdAt: now,
      updatedAt: now,
    },
  });

  logger.info(
    { memoryId: memory._id, type, source, contentPreview: content.slice(0, 80) },
    "Memory stored",
  );
  return memory;
}

export async function recall(query: string, opts: RecallOptions = {}): Promise<RecallResult[]> {
  const { type, limit = 10, minScore = 0.3 } = opts;
  const queryEmbedding = await generateEmbedding(query);

  // Tiered search: try 90 days first, widen to 365 if insufficient
  let results = await _similaritySearch(queryEmbedding, { type, limit, minScore, maxAgeDays: 90 });
  if (results.length < limit) {
    results = await _similaritySearch(queryEmbedding, { type, limit, minScore, maxAgeDays: 365 });
  }

  return results;
}

export async function forget(memoryId: string): Promise<boolean> {
  const result = await Memory.findByIdAndDelete(memoryId);
  if (result) {
    logger.info({ memoryId }, "Memory deleted");
    return true;
  }
  logger.warn({ memoryId }, "Memory not found for deletion");
  return false;
}

// ---------------------------------------------------------------------------
// Episode retrieval (separated by type to fix conflation bug)
// ---------------------------------------------------------------------------

export async function getRecentDailyEpisodes(limit = 3): Promise<IMemory[]> {
  return Memory.find({
    type: "episode",
    source: { $nin: ["weekly-merge", "monthly-consolidation"] },
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(limit)
    .exec();
}

export async function getRecentWeeklyEpisodes(limit = 2): Promise<IMemory[]> {
  return Memory.find({
    type: "episode",
    source: "weekly-merge",
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(limit)
    .exec();
}

/** @deprecated Use getRecentDailyEpisodes/getRecentWeeklyEpisodes instead */
export async function getRecentEpisodes(limit = 3): Promise<IMemory[]> {
  return Memory.find({
    type: "episode",
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(limit)
    .exec();
}

export async function getEpisodesBefore(
  olderThan: Date,
  excludeSources?: string[],
): Promise<IMemory[]> {
  const filter: Record<string, unknown> = {
    type: "episode",
    "metadata.createdAt": { $lt: olderThan },
    "metadata.archivedAt": { $exists: false },
  };
  if (excludeSources?.length) {
    filter.source = { $nin: excludeSources };
  }
  return Memory.find(filter).sort({ "metadata.createdAt": -1 }).exec();
}

// ---------------------------------------------------------------------------
// Fact retrieval (bounded)
// ---------------------------------------------------------------------------

export async function getTopFacts(limit = 30): Promise<IMemory[]> {
  return Memory.find({
    type: "fact",
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.importance": -1, "metadata.createdAt": -1 })
    .limit(limit)
    .exec();
}

export async function getFactsByRelevance(query: string, limit = 30): Promise<IMemory[]> {
  const queryEmbedding = await generateEmbedding(query);

  const candidates = await Memory.find({
    type: "fact",
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(200)
    .lean()
    .exec();

  const scored = candidates
    .filter((c) => c.embedding?.length)
    .map((c) => ({
      doc: c,
      score: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .filter((s) => s.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Return as full documents by fetching by IDs
  const ids = scored.map((s) => s.doc._id);
  if (ids.length === 0) return [];
  const docs = await Memory.find({ _id: { $in: ids } }).exec();

  // Maintain score-sorted order
  const docMap = new Map(docs.map((d) => [d._id.toString(), d]));
  return ids.map((id) => docMap.get(id.toString())).filter((d) => d != null);
}

export async function getFactCount(): Promise<number> {
  return Memory.countDocuments({
    type: "fact",
    "metadata.archivedAt": { $exists: false },
  });
}

/** @deprecated Use getTopFacts or getFactsByRelevance instead */
export async function getAllFacts(): Promise<IMemory[]> {
  return Memory.find({
    type: "fact",
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .exec();
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function getRecentMilestones(limit = 5): Promise<IMemory[]> {
  return Memory.find({
    type: "milestone",
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(limit)
    .exec();
}

// ---------------------------------------------------------------------------
// Follow-up lifecycle
// ---------------------------------------------------------------------------

export async function getActiveFollowUps(limit = 10, maxAgeDays = 30): Promise<string[]> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  const memories = await Memory.find({
    "metadata.followUps": { $exists: true, $ne: [] },
    "metadata.createdAt": { $gte: cutoff },
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(limit)
    .exec();

  // Dedup by lowercased text
  const seen = new Set<string>();
  const followUps: string[] = [];
  for (const mem of memories) {
    if (mem.metadata.followUps) {
      for (const fu of mem.metadata.followUps) {
        const key = fu.toLowerCase().trim();
        if (!seen.has(key)) {
          seen.add(key);
          followUps.push(fu);
        }
      }
    }
  }
  return followUps;
}

export async function getActiveFollowUpsWithIds(
  limit = 10,
  maxAgeDays = 30,
): Promise<{ memoryId: string; text: string }[]> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  const memories = await Memory.find({
    "metadata.followUps": { $exists: true, $ne: [] },
    "metadata.createdAt": { $gte: cutoff },
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(limit)
    .exec();

  const seen = new Set<string>();
  const results: { memoryId: string; text: string }[] = [];
  for (const mem of memories) {
    if (mem.metadata.followUps) {
      for (const fu of mem.metadata.followUps) {
        const key = fu.toLowerCase().trim();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ memoryId: mem._id.toString(), text: fu });
        }
      }
    }
  }
  return results;
}

export async function resolveFollowUp(memoryId: string, followUpText: string): Promise<void> {
  await Memory.findByIdAndUpdate(memoryId, {
    $pull: { "metadata.followUps": followUpText },
  });
}

// ---------------------------------------------------------------------------
// Working memory (session-scoped, TTL-based)
// ---------------------------------------------------------------------------

export async function setWorkingMemory(
  content: string,
  sessionId: string,
  ttlHours = 24,
): Promise<IMemory> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  const memory = await Memory.create({
    content,
    type: "working",
    source: "note-to-self",
    embedding: [], // Working memory doesn't need embeddings
    metadata: {
      sessionId,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    },
  });

  logger.info({ memoryId: memory._id, sessionId, ttlHours }, "Working memory stored");
  return memory;
}

export async function getWorkingMemories(sessionId: string): Promise<IMemory[]> {
  return Memory.find({
    type: "working",
    "metadata.sessionId": sessionId,
  })
    .sort({ "metadata.createdAt": -1 })
    .exec();
}

export async function clearWorkingMemories(sessionId: string): Promise<void> {
  await Memory.deleteMany({
    type: "working",
    "metadata.sessionId": sessionId,
  });
}

// ---------------------------------------------------------------------------
// Non-destructive archival (replaces forget() in merge operations)
// ---------------------------------------------------------------------------

export async function archiveMemory(memoryId: string, mergedIntoId?: string): Promise<void> {
  const update: Record<string, unknown> = {
    "metadata.archivedAt": new Date(),
  };
  if (mergedIntoId) {
    update["metadata.mergedInto"] = mergedIntoId;
  }
  await Memory.findByIdAndUpdate(memoryId, { $set: update });
}

export async function archiveMany(memoryIds: string[], mergedIntoId?: string): Promise<void> {
  const update: Record<string, unknown> = {
    "metadata.archivedAt": new Date(),
  };
  if (mergedIntoId) {
    update["metadata.mergedInto"] = mergedIntoId;
  }
  await Memory.updateMany({ _id: { $in: memoryIds } }, { $set: update });
  logger.info({ count: memoryIds.length, mergedIntoId }, "Archived memories");
}

// ---------------------------------------------------------------------------
// Emotional baseline (unchanged)
// ---------------------------------------------------------------------------

export interface EmotionalBaseline {
  average: number;
  trend: "rising" | "falling" | "stable";
  recentScores: number[];
}

const TREND_THRESHOLD = 1.0;
const MIN_BASELINE_POINTS = 3;

export async function getEmotionalBaseline(windowSize = 10): Promise<EmotionalBaseline | null> {
  const episodes = await Memory.find({
    type: "episode",
    "metadata.emotionalTone": { $exists: true },
    "metadata.archivedAt": { $exists: false },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(windowSize)
    .exec();

  const scores = episodes
    .map((e) => e.metadata.emotionalTone)
    .filter((t): t is number => t != null);

  if (scores.length < MIN_BASELINE_POINTS) return null;

  const average = scores.reduce((a, b) => a + b, 0) / scores.length;

  const mid = Math.ceil(scores.length / 2);
  const recentHalf = scores.slice(0, mid);
  const olderHalf = scores.slice(mid);

  const recentAvg = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;
  const olderAvg = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;
  const diff = recentAvg - olderAvg;

  let trend: "rising" | "falling" | "stable" = "stable";
  if (diff >= TREND_THRESHOLD) trend = "rising";
  else if (diff <= -TREND_THRESHOLD) trend = "falling";

  return { average, trend, recentScores: scores };
}

// ---------------------------------------------------------------------------
// Composite scoring (unchanged)
// ---------------------------------------------------------------------------

const WEIGHT_RELEVANCE = 0.5;
const WEIGHT_RECENCY = 0.25;
const WEIGHT_IMPORTANCE = 0.15;
const WEIGHT_EMOTIONAL = 0.1;
const RECENCY_HALF_LIFE_DAYS = 30;

function computeCompositeScore(
  relevance: number,
  createdAt: Date,
  importance?: number,
  emotionalTone?: number,
): number {
  const ageDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  const recency = Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
  const importanceNorm = (importance ?? 5) / 10;
  const emotionalWeight = Math.abs((emotionalTone ?? 5) - 5) / 5;

  return (
    WEIGHT_RELEVANCE * relevance +
    WEIGHT_RECENCY * recency +
    WEIGHT_IMPORTANCE * importanceNorm +
    WEIGHT_EMOTIONAL * emotionalWeight
  );
}

// ---------------------------------------------------------------------------
// Bounded similarity search
// ---------------------------------------------------------------------------

const MAX_CANDIDATES = 200;

async function _similaritySearch(
  queryEmbedding: number[],
  opts: { type?: string; limit: number; minScore: number; maxAgeDays?: number },
): Promise<RecallResult[]> {
  const filter: Record<string, unknown> = {
    "metadata.archivedAt": { $exists: false },
  };
  if (opts.type) filter.type = opts.type;

  if (opts.maxAgeDays) {
    const cutoff = new Date(Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000);
    filter["metadata.createdAt"] = { $gte: cutoff };
  }

  // Exclude working memory from search
  if (!opts.type) {
    filter.type = { $ne: "working" };
  }

  const candidates = await Memory.find(filter)
    .sort({ "metadata.createdAt": -1 })
    .limit(MAX_CANDIDATES)
    .select("-source")
    .lean()
    .exec();

  const scored: RecallResult[] = [];
  for (const candidate of candidates) {
    if (!candidate.embedding?.length) continue;
    const relevance = cosineSimilarity(queryEmbedding, candidate.embedding);
    if (relevance < opts.minScore) continue;

    const score = computeCompositeScore(
      relevance,
      candidate.metadata.createdAt,
      candidate.metadata.importance,
      candidate.metadata.emotionalTone,
    );

    scored.push({
      id: candidate._id.toString(),
      content: candidate.content,
      type: candidate.type,
      score,
      metadata: candidate.metadata,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit);
}
