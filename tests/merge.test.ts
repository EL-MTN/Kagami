import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpVault: string;

before(async () => {
  tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'brainiac-merge-'));
  process.env.BRAINIAC_VAULT = tmpVault;
});

after(async () => {
  await fs.rm(tmpVault, { recursive: true, force: true });
});

test('merge moves observations, unions aliases, deletes source, rewrites wikilinks', async () => {
  const { createEntity, appendObservation, mergeEntities, readEntity, entityExists } =
    await import('../src/entity_io.ts');
  const { paths } = await import('../src/paths.ts');

  await createEntity({
    id: 'alex-smith',
    name: 'Alex Smith',
    aliases: ['Alex', 'A.S.'],
    type: 'person',
    anchor: '',
    updated: '2026-04-27',
  });
  await createEntity({
    id: 'alex-s',
    name: 'Alex S',
    aliases: ['Alex Smith Jr'],
    type: 'person',
    anchor: '',
    updated: '2026-04-27',
  });

  await appendObservation('alex-smith', {
    date: '2026-04-27',
    headline: 'First obs on smith',
    quote: 'q1',
    source: '[[raw/2026-04-27#t-0001]]',
    event_date: '',
  });
  await appendObservation('alex-s', {
    date: '2026-04-28',
    headline: 'Obs on the dup',
    quote: 'q2',
    source: '[[raw/2026-04-28#t-0001]]',
    event_date: '',
  });

  // A third entity that wikilinks the soon-to-be-merged one.
  await createEntity({
    id: 'vercel',
    name: 'Vercel',
    aliases: ['Vercel'],
    type: 'project',
    anchor: '',
    updated: '2026-04-27',
  });
  const vercelFile = path.join(paths.entities, 'vercel.md');
  const original = await fs.readFile(vercelFile, 'utf8');
  await fs.writeFile(vercelFile, original + '\nFounded by [[alex-s]] in 2024.\n');

  const r = await mergeEntities('alex-s', 'alex-smith');
  assert.equal(r.observations_moved, 1);
  assert.equal(r.wikilinks_rewritten, 1);

  // Source gone.
  assert.equal(await entityExists('alex-s'), false);

  // Target absorbed observations + aliases.
  const target = await readEntity('alex-smith');
  assert.match(target.body, /Obs on the dup/);
  assert.match(target.body, /First obs on smith/);
  // Alex Smith's name + aliases plus alex-s's name + aliases, deduped.
  assert.deepEqual(target.frontmatter.aliases.sort(), [
    'A.S.',
    'Alex',
    'Alex S',
    'Alex Smith Jr',
  ]);

  // Vercel's wikilink was rewritten.
  const vercel = await fs.readFile(vercelFile, 'utf8');
  assert.match(vercel, /\[\[alex-smith\]\]/);
  assert.doesNotMatch(vercel, /\[\[alex-s\]\]/);
});
