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

test('readFacts returns empty array when collection is empty', async () => {
  const { readFacts } = await import('../src/storage/facts.ts');
  assert.deepEqual(await readFacts(), []);
});

test('appendFacts then readFacts roundtrips', async () => {
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

test('appendFacts skips duplicates by hash unique index', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  const a = makeFact({ id: newFactId(), hash: 'shared', source_session: 'raw/s1' });
  const dup = makeFact({ id: newFactId(), hash: 'shared', source_session: 'raw/s2' });
  await appendFacts([a]);
  await appendFacts([dup]);
  const facts = await readFacts();
  assert.equal(facts.length, 1);
});

test('appendFacts inserts non-dupes alongside dupes in the same batch', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  await appendFacts([makeFact({ id: newFactId(), hash: 'h1' })]);
  const dup = makeFact({ id: newFactId(), hash: 'h1' });
  const fresh = makeFact({ id: newFactId(), hash: 'h2', text: 'new' });
  await appendFacts([dup, fresh]);
  const facts = await readFacts();
  assert.equal(facts.length, 2);
  assert.ok(facts.some((f) => f.hash === 'h2'));
});

test('rewriteFacts replaces all facts', async () => {
  const { appendFacts, rewriteFacts, readFacts, newFactId } = await import('../src/storage/facts.ts');
  await appendFacts([makeFact({ id: newFactId(), hash: 'old', text: 'old' })]);
  const c = makeFact({
    id: newFactId(),
    text: 'Updated fact',
    created_at: '2024-02-01T00:00:00Z',
    event_date: '2024-02-01',
    source_session: 'raw/s3',
    hash: 'xyz',
    embedding: [0.5, 0.5, 0],
  });
  await rewriteFacts([c]);
  const facts = await readFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.text, 'Updated fact');
});

test('newFactId returns unique uuid-shaped strings', async () => {
  const { newFactId } = await import('../src/storage/facts.ts');
  const ids = new Set([newFactId(), newFactId(), newFactId()]);
  assert.equal(ids.size, 3);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f-]{36}$/);
  }
});

test('buildExtractionUserPrompt assembles all required sections in order', async () => {
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
