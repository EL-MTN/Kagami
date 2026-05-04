import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITY_BOOST_WEIGHT,
  getBm25Params,
  normalizeBm25,
  scoreAndRank,
} from '../src/retrieval/scoring.ts';
import { lemmatizeForBm25, extractEntities } from '../src/retrieval/text.ts';

test('lemmatizeForBm25 lowercases, drops stopwords, stems suffixes', () => {
  const out = lemmatizeForBm25('I was meeting with Alex about the meetings');
  // Stopwords (i, was, with, about, the) drop; meeting → meet (with -ing variant kept);
  // meetings → meeting (Porter -ing keeps original meetings? actually "meetings" → "meet")
  assert.ok(out.includes('meet'));
  assert.ok(out.includes('alex'));
  assert.ok(!out.includes(' i '));
  assert.ok(!out.includes('was'));
});

test('lemmatizeForBm25 preserves original -ing form alongside stem', () => {
  const out = lemmatizeForBm25('attending the meeting');
  // 'attending' → 'attend' but original 'attending' kept; 'meeting' → 'meet' + 'meeting'
  assert.ok(out.split(/\s+/).includes('attend'));
  assert.ok(out.split(/\s+/).includes('attending'));
});

test('extractEntities pulls multi-word proper nouns', () => {
  const ents = extractEntities('User bought a Honda Civic in San Francisco');
  const texts = ents.map((e) => e.text);
  assert.ok(texts.includes('Honda Civic'));
  assert.ok(texts.includes('San Francisco'));
});

test('extractEntities pulls quoted strings', () => {
  const ents = extractEntities('Listened to "The Hate U Give" yesterday');
  const quoted = ents.find((e) => e.type === 'QUOTED');
  assert.ok(quoted);
  assert.equal(quoted!.text, 'The Hate U Give');
});

test('extractEntities skips generic capitalized words', () => {
  const ents = extractEntities('User likes Things and Ideas');
  const texts = ents.map((e) => e.text.toLowerCase());
  assert.ok(!texts.includes('things'));
  assert.ok(!texts.includes('ideas'));
});

test('getBm25Params adapts midpoint to query length', () => {
  // Pass pre-lemmatized strings to bypass the lemmatizer's stopword drop.
  assert.deepEqual(getBm25Params('', 'one two'), [5.0, 0.7]);
  assert.deepEqual(getBm25Params('', 'one two three four'), [7.0, 0.6]);
  assert.deepEqual(getBm25Params('', 'one two three four five six seven'), [9.0, 0.5]);
  assert.deepEqual(
    getBm25Params('', 'one two three four five six seven eight nine ten eleven twelve'),
    [10.0, 0.5],
  );
  assert.deepEqual(
    getBm25Params(
      '',
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen',
    ),
    [12.0, 0.5],
  );
});

test('normalizeBm25 maps midpoint to 0.5', () => {
  assert.equal(normalizeBm25(5, 5, 0.7), 0.5);
});

test('scoreAndRank gates by threshold then fuses additively', () => {
  const candidates = [
    { id: 'a', score: 0.8 },
    { id: 'b', score: 0.05 },          // below threshold 0.1, gated
    { id: 'c', score: 0.4 },
  ];
  const bm25 = new Map([['a', 0.6], ['c', 0.0]]);
  const entity = new Map([['a', 0.4], ['c', 0.0]]);
  const ranked = scoreAndRank(candidates, bm25, entity, 0.1, 10);
  assert.equal(ranked.length, 2);              // b dropped
  assert.equal(ranked[0]!.id, 'a');            // a wins
  // a: (0.8 + 0.6 + 0.4) / 2.5 = 0.72
  assert.ok(Math.abs(ranked[0]!.score - 0.72) < 1e-9);
});

test('scoreAndRank divisor adapts to active signals', () => {
  // Only semantic active → divisor = 1.0
  const r1 = scoreAndRank(
    [{ id: 'a', score: 0.5 }],
    new Map(),
    new Map(),
    0.1,
    1,
  );
  assert.ok(Math.abs(r1[0]!.score - 0.5) < 1e-9);
});

test('ENTITY_BOOST_WEIGHT is 0.5', () => {
  assert.equal(ENTITY_BOOST_WEIGHT, 0.5);
});
