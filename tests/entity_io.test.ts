import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpVault: string;

before(async () => {
  tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'brainiac-test-'));
  process.env.BRAINIAC_VAULT = tmpVault;
});

after(async () => {
  await fs.rm(tmpVault, { recursive: true, force: true });
});

test('create + read + append + alias union', async () => {
  // Re-import after env is set so paths.ts picks up the tmp vault.
  const { createEntity, readEntity, appendObservation, unionAliases } =
    await import('../src/entity_io.ts');

  await createEntity({
    id: 'alex-smith',
    name: 'Alex Smith',
    aliases: ['Alex'],
    type: 'person',
    anchor: '',
    updated: '2026-04-27',
  });

  const initial = await readEntity('alex-smith');
  assert.equal(initial.frontmatter.id, 'alex-smith');
  assert.match(initial.body, /## Observations/);

  await appendObservation('alex-smith', {
    date: '2026-04-27',
    headline: 'Pushed back on local-first',
    quote: 'sync story is always going to be the bottleneck',
    source: '[[raw/2026-04-27-1430#t-0003]]',
  });

  const afterAppend = await readEntity('alex-smith');
  assert.match(afterAppend.body, /Pushed back on local-first/);
  assert.match(afterAppend.body, /\[\[raw\/2026-04-27-1430#t-0003\]\]/);
  assert.equal(afterAppend.frontmatter.updated, '2026-04-27');

  await unionAliases('alex-smith', ['A.S.', 'Alex']);
  const afterAlias = await readEntity('alex-smith');
  assert.deepEqual(afterAlias.frontmatter.aliases.sort(), ['A.S.', 'Alex']);
});

test('findByNameOrAlias matches case-insensitively', async () => {
  const { findByNameOrAlias } = await import('../src/entity_io.ts');
  const matches = await findByNameOrAlias('alex');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.id, 'alex-smith');
});
