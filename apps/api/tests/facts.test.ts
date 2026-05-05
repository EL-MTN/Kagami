import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet: MongoMemoryReplSet;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.KIOKU_MONGO_URI = replSet.getUri();
  process.env.KIOKU_MONGO_DB = `kioku_facts_test_${Date.now()}`;
  // Build the btree indexes (including the hash unique index that
  // appendFacts relies on for dedup). Search/vector indexes are skipped
  // because mongodb-memory-server is vanilla mongo without mongot.
  const { ensureIndexes } = await import('../src/storage/indexes.ts');
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import('../src/storage/mongo.ts');
  const db = await getDb();
  await db.collection('facts').deleteMany({});
});

after(async () => {
  const { closeMongo } = await import('../src/storage/mongo.ts');
  await closeMongo();
  await replSet.stop();
});

function makeFact(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    text: 'placeholder',
    user_id: 'default',
    created_at: '2024-01-01T00:00:00Z',
    event_date: '2024-01-01',
    source_session: 'raw/s',
    hash: 'h',
    embedding: [1, 0, 0],
    ...overrides,
  };
}

void test('readFacts returns empty array when collection is empty', async () => {
  const { readFacts } = await import('../src/storage/facts.ts');
  assert.deepEqual(await readFacts(), []);
});

void test('appendFacts then readFacts roundtrips', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const a = makeFact({
    id: newFactId(),
    text: 'User likes coffee',
    created_at: '2024-01-01T00:00:00Z',
    event_date: '2024-01-01',
    source_session: 'raw/s1',
    hash: 'abc',
    embedding: [1, 0, 0],
  });
  const b = makeFact({
    id: newFactId(),
    text: 'User has a cat named Mira',
    created_at: '2024-01-02T00:00:00Z',
    event_date: '2024-01-02',
    source_session: 'raw/s2',
    hash: 'def',
    embedding: [0, 1, 0],
  });
  await appendFacts([a]);
  await appendFacts([b]);
  const facts = await readFacts();
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.text, 'User likes coffee');
  assert.equal(facts[1]!.text, 'User has a cat named Mira');
  assert.deepEqual(facts[0]!.embedding, [1, 0, 0]);
});

void test('appendFacts skips duplicates by hash unique index', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const a = makeFact({ id: newFactId(), hash: 'shared', source_session: 'raw/s1' });
  const dup = makeFact({ id: newFactId(), hash: 'shared', source_session: 'raw/s2' });
  await appendFacts([a]);
  await appendFacts([dup]);
  const facts = await readFacts();
  assert.equal(facts.length, 1);
});

void test('appendFacts inserts non-dupes alongside dupes in the same batch', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  await appendFacts([makeFact({ id: newFactId(), hash: 'h1' })]);
  const dup = makeFact({ id: newFactId(), hash: 'h1' });
  const fresh = makeFact({ id: newFactId(), hash: 'h2', text: 'new' });
  await appendFacts([dup, fresh]);
  const facts = await readFacts();
  assert.equal(facts.length, 2);
  assert.ok(facts.some((f) => f.hash === 'h2'));
});

void test('parallel appendFacts converge on the deduped union (no mutex)', async () => {
  // Surrogate for the plan's "10 parallel consolidate() calls" stress
  // test. Real consolidate() goes through the LLM and is excluded from
  // the unit-test loop; the dedup contract that consolidate relies on
  // lives at the appendFacts layer, which is what this test pins down.
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const sharedHashes = ['h1', 'h2', 'h3'];
  const batches = Array.from({ length: 10 }, () =>
    sharedHashes.map((h) =>
      makeFact({ id: newFactId(), hash: h, text: `text-${h}` }),
    ),
  );
  await Promise.all(batches.map((b) => appendFacts(b)));
  const facts = await readFacts();
  assert.equal(facts.length, sharedHashes.length);
  assert.deepEqual(
    facts.map((f) => f.hash).sort(),
    [...sharedHashes].sort(),
  );
});

void test('hash unique index is scoped — same hash under different user_id coexists', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const a = makeFact({
    id: newFactId(),
    hash: 'shared',
    user_id: 'alice',
    text: 'User likes coffee',
  });
  const b = makeFact({
    id: newFactId(),
    hash: 'shared',
    user_id: 'bob',
    text: 'User likes coffee',
  });
  await appendFacts([a]);
  await appendFacts([b]);
  const facts = await readFacts();
  assert.equal(facts.length, 2);
  assert.deepEqual(
    facts.map((f) => f.user_id).sort(),
    ['alice', 'bob'],
  );
});

void test('hash unique index still blocks dupes within the same scope', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const a = makeFact({ id: newFactId(), hash: 'h', user_id: 'alice' });
  const dup = makeFact({ id: newFactId(), hash: 'h', user_id: 'alice' });
  await appendFacts([a]);
  await appendFacts([dup]);
  const facts = await readFacts();
  assert.equal(facts.length, 1);
});

void test('hash unique scope distinguishes run_id and agent_id too', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const baseScope = { user_id: 'alice', hash: 'h' };
  await appendFacts([makeFact({ id: newFactId(), ...baseScope })]);
  await appendFacts([makeFact({ id: newFactId(), ...baseScope, run_id: 'r1' })]);
  await appendFacts([
    makeFact({ id: newFactId(), ...baseScope, run_id: 'r1', agent_id: 'a1' }),
  ]);
  const facts = await readFacts();
  assert.equal(facts.length, 3);
});

void test('readFactsInScope filters to the supplied scope', async () => {
  const { appendFacts, readFactsInScope, newFactId } = await import(
    '../src/storage/facts.ts'
  );
  await appendFacts([
    makeFact({ id: newFactId(), hash: 'h1', user_id: 'alice' }),
    makeFact({ id: newFactId(), hash: 'h2', user_id: 'bob' }),
    makeFact({ id: newFactId(), hash: 'h3', user_id: 'alice', run_id: 'r1' }),
  ]);
  const aliceAll = await readFactsInScope({ user_id: 'alice' });
  assert.equal(aliceAll.length, 2);
  const aliceR1 = await readFactsInScope({ user_id: 'alice', run_id: 'r1' });
  assert.equal(aliceR1.length, 1);
  assert.equal(aliceR1[0]!.run_id, 'r1');
});

void test('normalizeCategory accepts the known list, falls back to misc otherwise', async () => {
  const { normalizeCategory, KIOKU_CATEGORIES } = await import(
    '../src/ingest/consolidate.ts'
  );
  for (const c of KIOKU_CATEGORIES) {
    assert.equal(normalizeCategory(c), c);
  }
  assert.equal(normalizeCategory('PROFESSIONAL_DETAILS'), 'professional_details');
  assert.equal(normalizeCategory('  food  '), 'food');
  assert.equal(normalizeCategory('not_a_real_category'), 'misc');
  assert.equal(normalizeCategory(undefined), 'misc');
  assert.equal(normalizeCategory(''), 'misc');
});

void test('appendFacts persists category', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const f = makeFact({
    id: newFactId(),
    hash: 'h-cat',
    text: 'User loves jazz',
    category: 'music',
  });
  await appendFacts([f]);
  const facts = await readFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.category, 'music');
});

void test('appendFacts persists run_id, agent_id, and metadata', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const f = makeFact({
    id: newFactId(),
    hash: 'h',
    user_id: 'alice',
    run_id: 'session-1',
    agent_id: 'kioku',
    metadata: { category: 'food', confidence: 0.9 },
  });
  await appendFacts([f]);
  const facts = await readFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.run_id, 'session-1');
  assert.equal(facts[0]!.agent_id, 'kioku');
  assert.deepEqual(facts[0]!.metadata, { category: 'food', confidence: 0.9 });
});

void test('appendFactsBulk on empty input returns empty array without LLM contact', async () => {
  const { appendFactsBulk } = await import('../src/ingest/append.ts');
  const out = await appendFactsBulk([]);
  assert.deepEqual(out, []);
});

void test('newFactId returns unique uuid-shaped strings', async () => {
  const { newFactId } = await import('../src/storage/facts.ts');
  const ids = new Set([newFactId(), newFactId(), newFactId()]);
  assert.equal(ids.size, 3);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f-]{36}$/);
  }
});

void test('buildExtractionUserPrompt assembles all required sections in order', async () => {
  const { buildExtractionUserPrompt } = await import('../src/ingest/consolidate.ts');
  const prompt = buildExtractionUserPrompt({
    newMessages: [{ role: 'user', content: 'hi' }],
    observationDate: '2023-05-04',
    currentDate: '2026-05-02',
    existingMemories: [{ id: 'uuid-1', text: 'User likes pizza' }],
  });
  assert.ok(prompt.includes('## Summary'));
  assert.ok(prompt.includes('## Last k Messages'));
  assert.ok(prompt.includes('## Recently Extracted Memories'));
  assert.ok(prompt.includes('## Existing Memories'));
  assert.ok(prompt.includes('uuid-1'));
  assert.ok(prompt.includes('User likes pizza'));
  assert.ok(prompt.includes('## New Messages'));
  assert.ok(prompt.includes('"role":"user"'));
  assert.ok(prompt.includes('## Observation Date\n2023-05-04'));
  assert.ok(prompt.includes('## Current Date\n2026-05-02'));
  assert.ok(prompt.endsWith('# Output:'));
});

void test('buildExtractionUserPrompt threads summary into the Summary section', async () => {
  const { buildExtractionUserPrompt } = await import('../src/ingest/consolidate.ts');
  const summary =
    'User is Marcus, a senior engineer at Shopify. The conversation covered career milestones and family.';
  const prompt = buildExtractionUserPrompt({
    newMessages: [{ role: 'user', content: 'hi' }],
    observationDate: '2025-08-19',
    currentDate: '2026-05-04',
    summary,
  });
  assert.ok(prompt.includes(`## Summary\n${summary}`));
});
