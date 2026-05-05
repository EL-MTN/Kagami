// Hybrid retrieval scoring. Combines three signals additively, each
// in [0, 1]:
//   semantic — cosine similarity over fact embeddings
//   bm25     — sigmoid-normalized BM25 over lemmatized fact text
//   entity   — entity-store similarity to query entities, attenuated
//              by how many facts the matched entity links to
//
// scoreAndRank divides by max_possible (which adapts to which signals
// fired) so the combined score stays in [0, 1] regardless of which
// channels are active for a given query.

import { lemmatizeForBm25 } from "./text.js";

export const ENTITY_BOOST_WEIGHT = 0.5;

// Returns [midpoint, steepness] for sigmoid normalization of $search BM25
// raw scores. Calibrated against Lucene/Atlas BM25, which produces scores
// in roughly the 1–8 range on Kioku-scale corpora — much more compressed
// than the in-process Okapi BM25 this layer originally targeted (which
// produced 5–20). LUCENE-8563 dropped the (k1+1) numerator factor in 2018
// so per-term contributions are ~2.4× smaller; the small per-vault corpus
// further compresses scores via reduced IDF.
//
// Empirically fit on a 20-item slice of LongMemEval-Oracle so that:
//   - top-relevant docs (max raw) → ≥0.85 normalized
//   - p75 docs                    → 0.5–0.7
//   - irrelevant tail             → <0.15
//
// See scripts/probe-bm25-scores.ts for the sampling tool used to refit.
export function getBm25Params(query: string, lemmatized?: string): [number, number] {
  const lem = lemmatized ?? lemmatizeForBm25(query);
  const numTerms = lem.split(/\s+/).filter(Boolean).length || 1;
  if (numTerms <= 3) return [1.5, 1.5];
  if (numTerms <= 6) return [2.0, 1.0];
  if (numTerms <= 9) return [2.5, 1.2];
  if (numTerms <= 15) return [3.0, 1.0];
  return [3.5, 1.0];
}

export function normalizeBm25(rawScore: number, midpoint: number, steepness: number): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

export interface SemanticCandidate {
  id: string;
  score: number; // semantic score in [0, 1]
}

export interface RankedResult {
  id: string;
  score: number; // combined score in [0, 1]
}

// Gate by semantic threshold, then add BM25 and entity boost (each
// already normalized to [0, 1]) and divide by max_possible (which
// adapts to which signals fired).
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
