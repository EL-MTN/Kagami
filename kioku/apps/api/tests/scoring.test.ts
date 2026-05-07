import { expect, it } from "vitest";
import {
  ENTITY_BOOST_WEIGHT,
  getBm25Params,
  normalizeBm25,
  scoreAndRank,
} from "../src/retrieval/scoring.ts";
import { lemmatizeForBm25, extractEntities } from "../src/retrieval/text.ts";

it("lemmatizeForBm25 lowercases, drops stopwords, stems suffixes", () => {
  const out = lemmatizeForBm25("I was meeting with Alex about the meetings");
  // Stopwords (i, was, with, about, the) drop; meeting → meet (with -ing variant kept);
  // meetings → meeting (Porter -ing keeps original meetings? actually "meetings" → "meet")
  expect(out).toContain("meet");
  expect(out).toContain("alex");
  expect(out).not.toContain(" i ");
  expect(out).not.toContain("was");
});

it("lemmatizeForBm25 preserves original -ing form alongside stem", () => {
  const out = lemmatizeForBm25("attending the meeting");
  // 'attending' → 'attend' but original 'attending' kept; 'meeting' → 'meet' + 'meeting'
  expect(out.split(/\s+/)).toContain("attend");
  expect(out.split(/\s+/)).toContain("attending");
});

it("extractEntities pulls multi-word proper nouns", () => {
  const ents = extractEntities("User bought a Honda Civic in San Francisco");
  const texts = ents.map((e) => e.text);
  expect(texts).toContain("Honda Civic");
  expect(texts).toContain("San Francisco");
});

it("extractEntities pulls quoted strings", () => {
  const ents = extractEntities('Listened to "The Hate U Give" yesterday');
  const quoted = ents.find((e) => e.type === "QUOTED");
  expect(quoted).toBeTruthy();
  expect(quoted!.text).toBe("The Hate U Give");
});

it("extractEntities skips generic capitalized words", () => {
  const ents = extractEntities("User likes Things and Ideas");
  const texts = ents.map((e) => e.text.toLowerCase());
  expect(texts).not.toContain("things");
  expect(texts).not.toContain("ideas");
});

it("getBm25Params adapts midpoint to query length", () => {
  // Pass pre-lemmatized strings to bypass the lemmatizer's stopword drop.
  // Values calibrated against Lucene/Atlas BM25 score distributions.
  expect(getBm25Params("", "one two")).toEqual([1.5, 1.5]);
  expect(getBm25Params("", "one two three four")).toEqual([2.0, 1.0]);
  expect(getBm25Params("", "one two three four five six seven")).toEqual([2.5, 1.2]);
  expect(
    getBm25Params("", "one two three four five six seven eight nine ten eleven twelve"),
  ).toEqual([3.0, 1.0]);
  expect(
    getBm25Params(
      "",
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
    ),
  ).toEqual([3.5, 1.0]);
});

it("normalizeBm25 maps midpoint to 0.5", () => {
  expect(normalizeBm25(2.5, 2.5, 1.2)).toBe(0.5);
});

it("scoreAndRank gates by threshold then fuses additively", () => {
  const candidates = [
    { id: "a", score: 0.8 },
    { id: "b", score: 0.05 }, // below threshold 0.1, gated
    { id: "c", score: 0.4 },
  ];
  const bm25 = new Map([
    ["a", 0.6],
    ["c", 0.0],
  ]);
  const entity = new Map([
    ["a", 0.4],
    ["c", 0.0],
  ]);
  const ranked = scoreAndRank(candidates, bm25, entity, 0.1, 10);
  expect(ranked.length).toBe(2); // b dropped
  expect(ranked[0]!.id).toBe("a"); // a wins
  // a: (0.8 + 0.6 + 0.4) / 2.5 = 0.72
  expect(Math.abs(ranked[0]!.score - 0.72)).toBeLessThan(1e-9);
});

it("scoreAndRank divisor adapts to active signals", () => {
  // Only semantic active → divisor = 1.0
  const r1 = scoreAndRank([{ id: "a", score: 0.5 }], new Map(), new Map(), 0.1, 1);
  expect(Math.abs(r1[0]!.score - 0.5)).toBeLessThan(1e-9);
});

it("ENTITY_BOOST_WEIGHT is 0.5", () => {
  expect(ENTITY_BOOST_WEIGHT).toBe(0.5);
});
