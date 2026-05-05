import { defaultFactRanker, type MemoryFilters, type RankedFact } from "../retrieval/embeddings.js";

// Ranked fact retrieval without the answerer LLM. Wraps the hybrid
// ranker so HTTP callers (and the bot) can pull top-K facts directly
// instead of going through answer.ts's single-shot answerer.

export interface RecalledFact {
  id: string;
  text: string;
  event_date: string;
  source_session: string;
  created_at: string;
}

export interface RecallOptions {
  k?: number;
  since?: string; // ISO date, inclusive lower bound on event_date
  until?: string; // ISO date, inclusive upper bound on event_date
  // Mem0-OSS-shaped scope + filters. Pushed down to $vectorSearch /
  // $search where the field is index-declared; metadata is post-filtered.
  filters?: MemoryFilters;
}

const DEFAULT_K = 10;

export async function recall(query: string, opts: RecallOptions = {}): Promise<RecalledFact[]> {
  const k = opts.k ?? DEFAULT_K;
  // Over-fetch when date filters are present so post-filter still
  // yields ~k results in the common case.
  const fetchK = opts.since || opts.until ? Math.max(k * 3, 30) : k;

  const ranked: RankedFact[] = await defaultFactRanker(query, fetchK, {
    filters: opts.filters,
  });

  const filtered = ranked.filter((f) => {
    if (opts.since && f.eventDate < opts.since) return false;
    if (opts.until && f.eventDate > opts.until) return false;
    return true;
  });

  return filtered.slice(0, k).map((f) => ({
    id: f.id,
    text: f.text,
    event_date: f.eventDate,
    source_session: f.sourceSession,
    created_at: f.createdAt,
  }));
}
