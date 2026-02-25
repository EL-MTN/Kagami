import { Memory, type IMemory } from "../db/models/memory.js";
import { generateEmbedding, cosineSimilarity } from "./embedding.js";
import { logger } from "../utils/logger.js";

export interface RememberOptions {
  chatId?: string;
  emotionalTone?: number;
  importance?: number;
  followUps?: string[];
  vaultPath?: string;
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
      vaultPath: options.vaultPath,
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
  return _similaritySearch(queryEmbedding, { type, limit, minScore });
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

export async function getRecentEpisodes(limit = 3): Promise<IMemory[]> {
  return Memory.find({ type: "episode" }).sort({ "metadata.createdAt": -1 }).limit(limit).exec();
}

export async function getAllFacts(): Promise<IMemory[]> {
  return Memory.find({ type: "fact" }).sort({ "metadata.createdAt": -1 }).exec();
}

export async function getActiveFollowUps(): Promise<string[]> {
  const memories = await Memory.find({
    "metadata.followUps": { $exists: true, $ne: [] },
  })
    .sort({ "metadata.createdAt": -1 })
    .limit(10)
    .exec();

  const followUps: string[] = [];
  for (const mem of memories) {
    if (mem.metadata.followUps) {
      followUps.push(...mem.metadata.followUps);
    }
  }
  return followUps;
}

// Generative Agents composite scoring weights
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

async function _similaritySearch(
  queryEmbedding: number[],
  opts: { type?: string; limit: number; minScore: number },
): Promise<RecallResult[]> {
  const filter: Record<string, unknown> = {};
  if (opts.type) filter.type = opts.type;

  const candidates = await Memory.find(filter).exec();

  const scored: RecallResult[] = [];
  for (const candidate of candidates) {
    if (!candidate.embedding?.length) continue;
    const relevance = cosineSimilarity(queryEmbedding, candidate.embedding);
    // minScore still applies as a relevance floor
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
