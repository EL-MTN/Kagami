import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript } from '../src/ingest/transcript.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures/transcript-1.md');

void test('parses frontmatter', async () => {
  const t = await readTranscript(fixture);
  assert.equal(t.frontmatter.id, '2026-04-27-1430');
  assert.equal(t.frontmatter.started_at, '2026-04-27T14:30:00.000Z');
});

void test('parses every turn', async () => {
  const t = await readTranscript(fixture);
  assert.equal(t.turns.length, 5);
  assert.equal(t.turns[0]!.id, 't-0001');
  assert.equal(t.turns[0]!.role, 'user');
  assert.match(t.turns[0]!.text, /coffee with Alex Smith/);
  assert.equal(t.turns[4]!.id, 't-0005');
  assert.match(t.turns[4]!.text, /skew shorter/);
});

void test('turn text excludes the heading line', async () => {
  const t = await readTranscript(fixture);
  for (const turn of t.turns) {
    assert.doesNotMatch(turn.text, /^##\s+t-/m);
  }
});
