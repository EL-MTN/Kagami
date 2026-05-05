import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet: MongoMemoryReplSet;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.KIOKU_MONGO_URI = replSet.getUri();
  process.env.KIOKU_MONGO_DB = `kioku_test_${Date.now()}`;
  // mongodb-memory-server is vanilla mongo without mongot. $listSearchIndexes
  // throws before we'd ever hit the embedding provider, and allowMissingSearch
  // below swallows that — so no embedding probe runs in this test.
});

after(async () => {
  const { closeMongo } = await import('../src/storage/mongo.ts');
  await closeMongo();
  await replSet.stop();
});

void test('ensureIndexes creates btree indexes on facts/entities/history', async () => {
  const { ensureIndexes } = await import('../src/storage/indexes.ts');
  const { getDb } = await import('../src/storage/mongo.ts');

  await ensureIndexes({ allowMissingSearch: true });

  const db = await getDb();
  const factIdx = await db.collection('facts').indexes();
  const entIdx = await db.collection('entities').indexes();
  const histIdx = await db.collection('history').indexes();

  assert.ok(factIdx.find((i) => i.name === 'facts_hash_unique')?.unique);
  assert.ok(factIdx.find((i) => i.name === 'facts_user_created'));
  assert.ok(entIdx.find((i) => i.name === 'entities_text_lower_unique')?.unique);
  assert.ok(histIdx.find((i) => i.name === 'history_memory_created'));
});

void test('ensureIndexes is idempotent across calls', async () => {
  const { ensureIndexes } = await import('../src/storage/indexes.ts');
  await ensureIndexes({ allowMissingSearch: true });
  await ensureIndexes({ allowMissingSearch: true });
  await ensureIndexes({ allowMissingSearch: true });
  // No throw — same indexes stay in place.
});

