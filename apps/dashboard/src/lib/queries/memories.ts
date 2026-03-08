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

export async function getMemoriesByType(
  type: string,
  page = 1,
): Promise<{ items: MemoryListItem[]; total: number; pageSize: number }> {
  await ensureDB();

  const skip = (page - 1) * PAGE_SIZE;
  const filter = { type, "metadata.archivedAt": { $exists: false } };

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
