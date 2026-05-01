import { Memory } from "@mashiro/db";
import type { IMemory } from "@mashiro/db";
import { ensureDB } from "../db";

export interface MemoryListItem {
  id: string;
  content: string;
  type: IMemory["type"];
  source: string;
  importance?: number;
  emotionalTone?: number;
  createdAt: Date;
}

const PAGE_SIZE = 20;

export type ToneFilter = "positive" | "neutral" | "negative";
export type ImportanceFilter = "low" | "medium" | "high";

export interface MemoryFilterOptions {
  tone?: ToneFilter;
  importance?: ImportanceFilter;
  /** Substring match against memory.source. */
  source?: string;
}

const TONE_RANGES: Record<ToneFilter, { min?: number; max?: number }> = {
  positive: { min: 0.2 },
  neutral: { min: -0.2, max: 0.2 },
  negative: { max: -0.2 },
};

const IMPORTANCE_RANGES: Record<ImportanceFilter, { min?: number; max?: number }> = {
  low: { max: 3 },
  medium: { min: 4, max: 6 },
  high: { min: 7 },
};

function buildMemoryFilter(type: string, options: MemoryFilterOptions): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    type,
    "metadata.archivedAt": { $exists: false },
  };

  if (options.tone) {
    const range = TONE_RANGES[options.tone];
    const cmp: Record<string, number> = {};
    if (range.min !== undefined) cmp.$gte = range.min;
    if (range.max !== undefined) cmp.$lt = range.max;
    filter["metadata.emotionalTone"] = cmp;
  }

  if (options.importance) {
    const range = IMPORTANCE_RANGES[options.importance];
    const cmp: Record<string, number> = {};
    if (range.min !== undefined) cmp.$gte = range.min;
    if (range.max !== undefined) cmp.$lte = range.max;
    filter["metadata.importance"] = cmp;
  }

  if (options.source) {
    filter.source = {
      $regex: options.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    };
  }

  return filter;
}

export async function getMemoriesByType(
  type: string,
  page = 1,
  options: MemoryFilterOptions = {},
): Promise<{ items: MemoryListItem[]; total: number; pageSize: number }> {
  await ensureDB();

  const skip = (page - 1) * PAGE_SIZE;
  const filter = buildMemoryFilter(type, options);

  const [items, total] = await Promise.all([
    Memory.find(filter)
      .sort({ "metadata.createdAt": -1 })
      .skip(skip)
      .limit(PAGE_SIZE)
      .select("content type source metadata")
      .lean(),
    Memory.countDocuments(filter),
  ]);

  return {
    items: items.map((m) => ({
      id: m._id.toString(),
      content: m.content,
      type: m.type,
      source: m.source,
      importance: m.metadata.importance,
      emotionalTone: m.metadata.emotionalTone,
      createdAt: m.metadata.createdAt,
    })),
    total,
    pageSize: PAGE_SIZE,
  };
}

export interface MemoryTypeCounts {
  fact: number;
  episode: number;
  milestone: number;
  working: number;
}

export async function getMemoryTypeCounts(): Promise<MemoryTypeCounts> {
  await ensureDB();

  const result = await Memory.aggregate<{ _id: string; count: number }>([
    { $match: { "metadata.archivedAt": { $exists: false } } },
    { $group: { _id: "$type", count: { $sum: 1 } } },
  ]);

  const counts: MemoryTypeCounts = { fact: 0, episode: 0, milestone: 0, working: 0 };
  for (const r of result) {
    if (r._id in counts) {
      counts[r._id as keyof MemoryTypeCounts] = r.count;
    }
  }
  return counts;
}
