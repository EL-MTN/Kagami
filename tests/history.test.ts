import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet: MongoMemoryReplSet;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.KIOKU_MONGO_URI = replSet.getUri();
  process.env.KIOKU_MONGO_DB = `kioku_history_test_${Date.now()}`;
  const { ensureIndexes } = await import('../src/storage/indexes.ts');
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import('../src/storage/mongo.ts');
  const db = await getDb();
  await Promise.all([
    db.collection('facts').deleteMany({}),
    db.collection('history').deleteMany({}),
  ]);
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

test('appendFacts emits one ADD event per inserted fact', async () => {
  const { appendFacts, newFactId } = await import('../src/storage/facts.ts');
  const { readHistoryFor } = await import('../src/storage/history.ts');
  const a = makeFact({ id: newFactId(), hash: 'h-a', text: 'A' });
  const b = makeFact({ id: newFactId(), hash: 'h-b', text: 'B' });
  await appendFacts([a, b], 'append');
  const histA = await readHistoryFor(a.id);
  const histB = await readHistoryFor(b.id);
  assert.equal(histA.length, 1);
  assert.equal(histA[0]!.event, 'ADD');
  assert.equal(histA[0]!.new_text, 'A');
  assert.equal(histA[0]!.actor, 'append');
  assert.equal(histB.length, 1);
  assert.equal(histB[0]!.event, 'ADD');
});

test('appendFacts does not emit ADD events for hash dupes', async () => {
  const { appendFacts, newFactId } = await import('../src/storage/facts.ts');
  const { readHistoryFor } = await import('../src/storage/history.ts');
  const original = makeFact({ id: newFactId(), hash: 'h1', text: 'orig' });
  await appendFacts([original]);
  const dupId = newFactId();
  const dup = makeFact({ id: dupId, hash: 'h1', text: 'dup' });
  await appendFacts([dup]);
  // The dup never landed, so no event for its synthetic id.
  const dupHistory = await readHistoryFor(dupId);
  assert.equal(dupHistory.length, 0);
  // The original got exactly one ADD.
  const origHistory = await readHistoryFor(original.id);
  assert.equal(origHistory.length, 1);
});

test('rewriteFacts emits ADD/UPDATE/DELETE diff with old_text captured', async () => {
  const { appendFacts, rewriteFacts, newFactId } = await import('../src/storage/facts.ts');
  const { readHistoryFor } = await import('../src/storage/history.ts');
  const keep = makeFact({ id: newFactId(), hash: 'k', text: 'unchanged' });
  const update = makeFact({ id: newFactId(), hash: 'u', text: 'before' });
  const remove = makeFact({ id: newFactId(), hash: 'd', text: 'doomed' });
  await appendFacts([keep, update, remove]);

  const updateAfter = { ...update, text: 'after' };
  const fresh = makeFact({ id: newFactId(), hash: 'n', text: 'new' });
  await rewriteFacts([keep, updateAfter, fresh], 'rewrite');

  const keepHist = await readHistoryFor(keep.id);
  const updateHist = await readHistoryFor(update.id);
  const removeHist = await readHistoryFor(remove.id);
  const freshHist = await readHistoryFor(fresh.id);

  // keep had only its initial ADD; rewrite produced no event for it.
  assert.equal(keepHist.length, 1);
  assert.equal(keepHist[0]!.event, 'ADD');

  // update has the original ADD plus an UPDATE with both texts.
  assert.equal(updateHist.length, 2);
  const upd = updateHist.find((e) => e.event === 'UPDATE')!;
  assert.equal(upd.old_text, 'before');
  assert.equal(upd.new_text, 'after');
  assert.equal(upd.actor, 'rewrite');

  // remove has the original ADD plus a DELETE with the old text.
  assert.equal(removeHist.length, 2);
  const del = removeHist.find((e) => e.event === 'DELETE')!;
  assert.equal(del.old_text, 'doomed');
  assert.equal(del.new_text, undefined);

  // fresh got an ADD event from the rewrite path.
  assert.equal(freshHist.length, 1);
  assert.equal(freshHist[0]!.event, 'ADD');
  assert.equal(freshHist[0]!.new_text, 'new');
});

test('readHistoryFor returns events newest first', async () => {
  const { recordEvent, readHistoryFor } = await import('../src/storage/history.ts');
  await recordEvent({ memory_id: 'mid', event: 'ADD', new_text: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  await recordEvent({ memory_id: 'mid', event: 'UPDATE', old_text: 'a', new_text: 'b' });
  await new Promise((r) => setTimeout(r, 5));
  await recordEvent({ memory_id: 'mid', event: 'DELETE', old_text: 'b' });
  const hist = await readHistoryFor('mid');
  assert.equal(hist.length, 3);
  assert.equal(hist[0]!.event, 'DELETE');
  assert.equal(hist[1]!.event, 'UPDATE');
  assert.equal(hist[2]!.event, 'ADD');
});
