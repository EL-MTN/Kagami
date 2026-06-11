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

import { z } from "zod";
import { lemmatizeForBm25 } from "./text.js";

export const ENTITY_BOOST_WEIGHT = 0.5;

interface Bm25ParamBucket {
  maxTerms: number | null;
  midpointEnv: string;
  steepnessEnv: string;
  midpoint: number;
  steepness: number;
}

const DEFAULT_BM25_PARAM_BUCKETS: readonly Bm25ParamBucket[] = [
  {
    maxTerms: 3,
    midpointEnv: "BM25_SIGMOID_MIDPOINT_3",
    steepnessEnv: "BM25_SIGMOID_STEEPNESS_3",
    midpoint: 1.5,
    steepness: 1.5,
  },
  {
    maxTerms: 6,
    midpointEnv: "BM25_SIGMOID_MIDPOINT_6",
    steepnessEnv: "BM25_SIGMOID_STEEPNESS_6",
    midpoint: 2.0,
    steepness: 1.0,
  },
  {
    maxTerms: 9,
    midpointEnv: "BM25_SIGMOID_MIDPOINT_9",
    steepnessEnv: "BM25_SIGMOID_STEEPNESS_9",
    midpoint: 2.5,
    steepness: 1.2,
  },
  {
    maxTerms: 15,
    midpointEnv: "BM25_SIGMOID_MIDPOINT_15",
    steepnessEnv: "BM25_SIGMOID_STEEPNESS_15",
    midpoint: 3.0,
    steepness: 1.0,
  },
  {
    maxTerms: null,
    midpointEnv: "BM25_SIGMOID_MIDPOINT_GT15",
    steepnessEnv: "BM25_SIGMOID_STEEPNESS_GT15",
    midpoint: 3.5,
    steepness: 1.0,
  },
] as const;

const NonNegativeFiniteNumber = z.coerce.number().finite().nonnegative();
const PositiveFiniteNumber = z.coerce.number().finite().positive();

function parseOptionalNumber(
  envName: string,
  fallback: number,
  schema: z.ZodType<number>,
  description: string,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${envName} must be a finite ${description}`);
  }
  return parsed.data;
}

export function loadBm25ParamsFromEnv(env: NodeJS.ProcessEnv = process.env): Bm25ParamBucket[] {
  return DEFAULT_BM25_PARAM_BUCKETS.map((bucket) => ({
    ...bucket,
    midpoint: parseOptionalNumber(
      bucket.midpointEnv,
      bucket.midpoint,
      NonNegativeFiniteNumber,
      "non-negative number",
      env,
    ),
    steepness: parseOptionalNumber(
      bucket.steepnessEnv,
      bucket.steepness,
      PositiveFiniteNumber,
      "positive number",
      env,
    ),
  }));
}

const BM25_PARAM_BUCKETS = loadBm25ParamsFromEnv();

export function getBm25ParamConfig(): Bm25ParamBucket[] {
  return BM25_PARAM_BUCKETS.map((bucket) => ({ ...bucket }));
}

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
  const bucket = BM25_PARAM_BUCKETS.find((candidate) => {
    return candidate.maxTerms === null || numTerms <= candidate.maxTerms;
  })!;
  return [bucket.midpoint, bucket.steepness];
}

export function normalizeBm25(rawScore: number, midpoint: number, steepness: number): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

interface SemanticCandidate {
  id: string;
  score: number; // semantic score in [0, 1]
}

export interface RankedResult {
  id: string;
  score: number; // combined score in [0, 1]
  // Per-channel contributions, pre-division — what the additive fusion
  // actually summed. Surfaced so /recall (and the dashboard's score
  // bars) can show WHY a fact ranked where it did.
  semantic: number; // cosine component in [0, 1]
  bm25: number; // sigmoid-normalized BM25 component in [0, 1]
  entity: number; // entity boost in [0, ENTITY_BOOST_WEIGHT]
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
    scored.push({
      id: r.id,
      score: Math.min(raw / maxPossible, 1.0),
      semantic: r.score,
      bm25,
      entity,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
