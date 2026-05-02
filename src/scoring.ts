// Verbatim port of mem0/utils/scoring.py.
//
// Hybrid retrieval combines three signals additively, each in [0, 1]:
//   semantic (cosine over embeddings)
//   bm25     (sigmoid-normalized BM25 over lemmatized text)
//   entity   (entity-store similarity to query entities, attenuated by
//             how many memories the matched entity links to)
//
// score_and_rank divides by max_possible (which adapts to which signals
// are present) so the combined score stays in [0, 1] regardless of which
// of the three signals fired.

import { lemmatizeForBm25 } from './text.js';

export const ENTITY_BOOST_WEIGHT = 0.5;

// Returns [midpoint, steepness] for sigmoid normalization. Longer queries
// produce higher raw BM25 scores so the midpoint shifts up with query
// length.
export function getBm25Params(
  query: string,
  lemmatized?: string,
): [number, number] {
  const lem = lemmatized ?? lemmatizeForBm25(query);
  const numTerms = lem.split(/\s+/).filter(Boolean).length || 1;
  if (numTerms <= 3) return [5.0, 0.7];
  if (numTerms <= 6) return [7.0, 0.6];
  if (numTerms <= 9) return [9.0, 0.5];
  if (numTerms <= 15) return [10.0, 0.5];
  return [12.0, 0.5];
}

export function normalizeBm25(
  rawScore: number,
  midpoint: number,
  steepness: number,
): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

export interface SemanticCandidate {
  id: string;
  score: number;            // semantic score in [0, 1]
}

export interface RankedResult {
  id: string;
  score: number;            // combined score in [0, 1]
}

// Mem0's score_and_rank: gate by semantic threshold, then add BM25 and
// entity boost (each already normalized to [0, 1]) and divide by
// max_possible (which adapts to which signals are non-empty).
export function scoreAndRank(
  semanticResults: SemanticCandidate[],
  bm25Scores: Map<string, number>,
  entityBoosts: Map<string, number>,
  threshold: number,
  topK: number,
): RankedResult[] {
  const hasBm25 = bm25Scores.size > 0;
  const hasEntity = entityBoosts.size > 0;

  let maxPossible = 1.0;
  if (hasBm25) maxPossible += 1.0;
  if (hasEntity) maxPossible += ENTITY_BOOST_WEIGHT;

  const scored: RankedResult[] = [];
  for (const r of semanticResults) {
    if (r.score < threshold) continue;
    const bm25 = bm25Scores.get(r.id) ?? 0;
    const entity = entityBoosts.get(r.id) ?? 0;
    const raw = r.score + bm25 + entity;
    scored.push({ id: r.id, score: Math.min(raw / maxPossible, 1.0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
