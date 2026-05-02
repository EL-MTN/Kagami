import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpVault: string;

before(async () => {
  tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'brainiac-facts-test-'));
  process.env.BRAINIAC_VAULT = tmpVault;
});

after(async () => {
  await fs.rm(tmpVault, { recursive: true, force: true });
});

test('readFacts returns empty array when file missing', async () => {
  const { readFacts } = await import('../src/facts.ts');
  assert.deepEqual(await readFacts(), []);
});

test('appendFacts then readFacts roundtrips', async () => {
  const { appendFacts, readFacts, newFactId } = await import('../src/facts.ts');
  const a = {
    id: newFactId(),
    text: 'User likes coffee',
    user_id: 'default',
    created_at: '2024-01-01T00:00:00Z',
    event_date: '2024-01-01',
    source_session: 'raw/s1',
    hash: 'abc',
    embedding: [1, 0, 0],
  };
  const b = {
    id: newFactId(),
    text: 'User has a cat named Mira',
    user_id: 'default',
    created_at: '2024-01-02T00:00:00Z',
    event_date: '2024-01-02',
    source_session: 'raw/s2',
    hash: 'def',
    embedding: [0, 1, 0],
  };
  await appendFacts([a]);
  await appendFacts([b]);
  const facts = await readFacts();
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.text, 'User likes coffee');
  assert.equal(facts[1]!.text, 'User has a cat named Mira');
  assert.deepEqual(facts[0]!.embedding, [1, 0, 0]);
});

test('rewriteFacts replaces all facts', async () => {
  const { rewriteFacts, readFacts, newFactId } = await import('../src/facts.ts');
  const c = {
    id: newFactId(),
    text: 'Updated fact',
    user_id: 'default',
    created_at: '2024-02-01T00:00:00Z',
    event_date: '2024-02-01',
    source_session: 'raw/s3',
    hash: 'xyz',
    embedding: [0.5, 0.5, 0],
  };
  await rewriteFacts([c]);
  const facts = await readFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.text, 'Updated fact');
});

test('newFactId returns unique uuid-shaped strings', async () => {
  const { newFactId } = await import('../src/facts.ts');
  const ids = new Set([newFactId(), newFactId(), newFactId()]);
  assert.equal(ids.size, 3);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f-]{36}$/);
  }
});

test('buildExtractionUserPrompt assembles all sections in mem0 order', async () => {
  const { buildExtractionUserPrompt } = await import('../src/ingest.ts');
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
