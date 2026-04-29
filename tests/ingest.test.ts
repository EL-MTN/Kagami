import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Candidate } from '../src/types.ts';

let tmpVault: string;

before(async () => {
  tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'brainiac-ingest-'));
  process.env.BRAINIAC_VAULT = tmpVault;
});

after(async () => {
  await fs.rm(tmpVault, { recursive: true, force: true });
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  entity_name: 'Alex Smith',
  type: 'person',
  aliases_seen: ['Alex'],
  headline: 'Pushed back on local-first',
  quote: 'sync story is always going to be the bottleneck',
  turn_id: 't-0003',
  date: '2026-04-27',
  event_date: '',
  ...over,
});

test('first candidate creates entity, second matches it by alias', async () => {
  const { applyCandidates } = await import('../src/ingest.ts');
  const { readEntity } = await import('../src/entity_io.ts');

  const r1 = await applyCandidates(
    [candidate()],
    '2026-04-27-1430',
  );
  assert.deepEqual(r1, {
    candidates: 1,
    appended: 1,
    created: 1,
    duplicated: 0,
  });

  const e1 = await readEntity('alex-smith');
  assert.equal(e1.frontmatter.name, 'Alex Smith');
  assert.deepEqual(e1.frontmatter.aliases.sort(), ['Alex', 'Alex Smith']);
  assert.match(e1.body, /Pushed back on local-first/);

  const r2 = await applyCandidates(
    [
      candidate({
        entity_name: 'Alex',
        aliases_seen: ['A.S.'],
        headline: 'Recommended Next.js',
        quote: 'just go with Next',
        turn_id: 't-0010',
        date: '2026-04-28',
      }),
    ],
    '2026-04-28-0900',
  );
  assert.equal(r2.created, 0);
  assert.equal(r2.appended, 1);

  const e2 = await readEntity('alex-smith');
  assert.deepEqual(e2.frontmatter.aliases.sort(), ['A.S.', 'Alex', 'Alex Smith']);
  assert.match(e2.body, /Recommended Next.js/);
  // newest first (reverse-chronological)
  const recIdx = e2.body.indexOf('Recommended');
  const pushIdx = e2.body.indexOf('Pushed back');
  assert.ok(recIdx < pushIdx, 'newest observation should appear above older');
});

test('multi-match candidate appends to every match', async () => {
  const { applyCandidates } = await import('../src/ingest.ts');
  const { createEntity, readEntity } = await import('../src/entity_io.ts');

  await createEntity({
    id: 'alex-jones',
    name: 'Alex Jones',
    aliases: ['Alex'],
    type: 'person',
    anchor: '',
    updated: '2025-08-01',
  });

  const r = await applyCandidates(
    [
      candidate({
        entity_name: 'Alex',
        headline: 'Climbed at Mission Cliffs',
        quote: 'top-roped a 5.10b',
        turn_id: 't-0020',
        date: '2026-04-29',
      }),
    ],
    '2026-04-29-1900',
  );
  assert.equal(r.duplicated, 1);
  assert.equal(r.appended, 2, 'one append per existing entity');

  const smith = await readEntity('alex-smith');
  const jones = await readEntity('alex-jones');
  assert.match(smith.body, /Climbed at Mission Cliffs/);
  assert.match(jones.body, /Climbed at Mission Cliffs/);
});

test('rebuilds index.md after ingest', async () => {
  const { applyCandidates } = await import('../src/ingest.ts');
  const { paths } = await import('../src/paths.ts');

  await applyCandidates(
    [candidate({ entity_name: 'Stripe', type: 'project', headline: 'employer' })],
    '2026-04-30-1000',
  );

  const idx = await fs.readFile(paths.index, 'utf8');
  assert.match(idx, /\[\[alex-smith\]\]/);
  assert.match(idx, /\[\[alex-jones\]\]/);
  assert.match(idx, /\[\[stripe\]\]/);
});

test('writes a log entry per append', async () => {
  const { paths } = await import('../src/paths.ts');
  const log = await fs.readFile(paths.log, 'utf8');
  const lines = log.trim().split('\n');
  assert.ok(lines.length >= 4, 'expected ≥4 log entries from prior tests');
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.ok(entry.ts && entry.entity_id && entry.decision);
  }
});

test('parsePrompt extracts system + user template', async () => {
  const { parsePrompt } = await import('../src/ingest.ts');
  const sample = [
    '# heading',
    '',
    '## System',
    '',
    'You are a thing.',
    '',
    '## User (template)',
    '',
    'Date: {{date}}',
  ].join('\n');
  const { system, userTemplate } = parsePrompt(sample);
  assert.equal(system, 'You are a thing.');
  assert.match(userTemplate, /Date: \{\{date\}\}/);
});
