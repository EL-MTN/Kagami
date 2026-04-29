import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpVault: string;

before(async () => {
  tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'brainiac-timeline-'));
  process.env.BRAINIAC_VAULT = tmpVault;
});

after(async () => {
  await fs.rm(tmpVault, { recursive: true, force: true });
});

test('parseObservations recovers headline, quote, source, date, event_date', async () => {
  const { parseObservations } = await import('../src/entity_io.ts');
  const body = `
## Observations

### 2023-04-10 — User had GPS issue on 3/22
> "I recently had an issue with my car's GPS system on 3/22"
**source:** [[raw/abc#t-0003]]
**date:** 2023-04-10
**event_date:** 2023-03-22

### 2023-04-10 — Car serviced on March 15
> "I just got my car serviced for the first time on March 15th"
**source:** [[raw/abc#t-0001]]
**date:** 2023-04-10
**event_date:** 2023-03-15

### 2023-04-10 — Wants shorter answers
> "going forward I want shorter answers from you"
**source:** [[raw/abc#t-0007]]
**date:** 2023-04-10
`;
  const obs = parseObservations(body);
  assert.equal(obs.length, 3);
  assert.equal(obs[0]!.event_date, '2023-03-22');
  assert.equal(obs[1]!.event_date, '2023-03-15');
  assert.equal(obs[2]!.event_date, '');
  assert.equal(obs[0]!.headline, 'User had GPS issue on 3/22');
  assert.equal(obs[0]!.source, '[[raw/abc#t-0003]]');
  assert.match(obs[0]!.quote, /GPS system on 3\/22/);
});

test('rebuildTimeline sorts by event_date with date fallback, includes wikilinks', async () => {
  const { createEntity, appendObservation } = await import('../src/entity_io.ts');
  const { rebuildTimeline } = await import('../src/timeline_md.ts');
  const { paths } = await import('../src/paths.ts');

  await createEntity({
    id: 'gps-system', name: 'GPS system', aliases: [], type: 'concept', anchor: '', updated: '2023-04-10',
  });
  await createEntity({
    id: 'car-service', name: 'car service', aliases: [], type: 'event', anchor: '', updated: '2023-04-10',
  });
  await createEntity({
    id: 'preference', name: 'shorter answers', aliases: [], type: 'preference', anchor: '', updated: '2023-04-10',
  });

  await appendObservation('gps-system', {
    date: '2023-04-10',
    event_date: '2023-03-22',
    headline: 'GPS issue resolved',
    quote: 'q',
    source: '[[raw/abc#t-0003]]',
  });
  await appendObservation('car-service', {
    date: '2023-04-10',
    event_date: '2023-03-15',
    headline: 'first car service',
    quote: 'q',
    source: '[[raw/abc#t-0001]]',
  });
  // No event_date — falls back to obs date.
  await appendObservation('preference', {
    date: '2023-04-10',
    event_date: '',
    headline: 'wants shorter answers',
    quote: 'q',
    source: '[[raw/abc#t-0007]]',
  });

  await rebuildTimeline();
  const tl = await fs.readFile(paths.timeline, 'utf8');
  const lines = tl.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 3);
  // March 15 first, then March 22, then April 10 (fallback).
  assert.match(lines[0]!, /^- 2023-03-15 — first car service \[\[car-service\]\]$/);
  assert.match(lines[1]!, /^- 2023-03-22 — GPS issue resolved \[\[gps-system\]\]$/);
  assert.match(lines[2]!, /^- 2023-04-10 — wants shorter answers \[\[preference\]\]$/);
});
