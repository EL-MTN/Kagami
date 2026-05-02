import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rankByCosine } from '../src/embeddings.ts';

let tmpVault: string;

before(async () => {
  tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'brainiac-emb-test-'));
  process.env.BRAINIAC_VAULT = tmpVault;
});

after(async () => {
  await fs.rm(tmpVault, { recursive: true, force: true });
});

test('rankByCosine returns top-k by cosine similarity descending', () => {
  // q points along x; "a" matches q exactly, "c" perpendicular, "b" 45deg.
  const q = [1, 0];
  const embs = new Map<string, number[]>([
    ['a', [1, 0]],
    ['b', [1, 1]],
    ['c', [0, 1]],
  ]);
  assert.deepEqual(rankByCosine(q, embs, 2), ['a', 'b']);
});

test('rankByCosine handles fewer entities than k', () => {
  const q = [1, 0];
  const embs = new Map<string, number[]>([
    ['a', [1, 0]],
    ['b', [0, 1]],
  ]);
  assert.deepEqual(rankByCosine(q, embs, 8), ['a', 'b']);
});

test('rankByCosine on empty input returns []', () => {
  assert.deepEqual(rankByCosine([1, 0], new Map(), 5), []);
});

test('defaultRanker handles entities with no observations', async () => {
  const { defaultRanker } = await import('../src/embeddings.ts');
  const { createEntity } = await import('../src/entity_io.ts');

  await createEntity({
    id: 'kotlin',
    name: 'Kotlin',
    aliases: ['kt'],
    type: 'skill',
    anchor: '',
    updated: '2026-04-30',
  });

  // Stub the embedding network calls — we just want to confirm that
  // an entity with no observations still feeds through defaultRanker
  // without throwing (it should fall back to alias-based text).
  // We can't easily stub the inner embed() calls, so this test only runs
  // when LM Studio + the embedding model are reachable.
  if (!process.env.LMSTUDIO_URL && !process.env.RUN_EMBEDDING_TESTS) {
    return; // skip silently
  }
  const ranked = await defaultRanker('what is kotlin', 5);
  assert.ok(ranked.some((c) => c.id === 'kotlin'));
});
