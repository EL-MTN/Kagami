import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVaultPath, buildUserPrompt, formatRankedSection, deriveQuestionDate } from '../src/query.ts';

test('isVaultPath accepts entities/ and raw/ paths', () => {
  assert.equal(isVaultPath('entities/typescript.md'), true);
  assert.equal(isVaultPath('raw/2026-04-27-1430.md'), true);
});

test('isVaultPath rejects path traversal', () => {
  assert.equal(isVaultPath('entities/../../../etc/passwd'), false);
  assert.equal(isVaultPath('raw/../foo.md'), false);
  assert.equal(isVaultPath('..'), false);
});

test('isVaultPath rejects absolute paths', () => {
  assert.equal(isVaultPath('/etc/passwd'), false);
  assert.equal(isVaultPath('/Users/x/secrets'), false);
});

test('isVaultPath rejects other top-level prefixes', () => {
  assert.equal(isVaultPath('_core.md'), false);
  assert.equal(isVaultPath('index.md'), false);
  assert.equal(isVaultPath('.memory/log.jsonl'), false);
  assert.equal(isVaultPath('.git/config'), false);
});

test('isVaultPath rejects empty and non-strings', () => {
  assert.equal(isVaultPath(''), false);
  // @ts-expect-error intentional invalid type
  assert.equal(isVaultPath(undefined), false);
  // @ts-expect-error intentional invalid type
  assert.equal(isVaultPath(null), false);
});

test('isVaultPath rejects null bytes', () => {
  assert.equal(isVaultPath('entities/\0evil.md'), false);
});

test('buildUserPrompt omits ranked section when empty', () => {
  const prompt = buildUserPrompt('core', 'index', 'timeline', 'q?', '', '2024-01-01');
  assert.ok(!prompt.includes('Pre-ranked candidates'));
  assert.ok(prompt.includes('_core.md'));
  assert.ok(prompt.includes('index.md'));
  assert.ok(prompt.includes('timeline.md'));
  assert.ok(prompt.includes("Today's date is 2024-01-01"));
  assert.ok(prompt.endsWith('Question: q?'));
});

test('buildUserPrompt places ranked section between index and timeline', () => {
  const ranked = '1. [[a]] — A (skill). Latest: x';
  const prompt = buildUserPrompt('core', 'index', 'timeline', 'q?', ranked, '2024-01-01');
  const indexAt = prompt.indexOf('index.md');
  const rankedAt = prompt.indexOf('Pre-ranked candidates');
  const timelineAt = prompt.indexOf('timeline.md');
  assert.ok(indexAt < rankedAt && rankedAt < timelineAt);
  assert.ok(prompt.includes(ranked));
});

test('deriveQuestionDate returns max date in timeline', () => {
  const tl = '# Timeline\n\n- 2023-01-15 — first [[a]]\n- 2024-06-20 — middle [[b]]\n- 2023-11-30 — sandwich [[c]]\n';
  assert.equal(deriveQuestionDate(tl), '2024-06-20');
});

test('deriveQuestionDate falls back to wall clock on empty timeline', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(deriveQuestionDate('# Timeline\n\n'), today);
});

test('formatRankedSection renders wikilinks and headlines', () => {
  const out = formatRankedSection([
    { id: 'a', name: 'A', type: 'skill', latestHeadline: 'first headline' },
    { id: 'b', name: 'B', type: 'project', latestHeadline: '' },
  ]);
  assert.equal(
    out,
    '1. [[a]] — A (skill). Latest: first headline\n' +
      '2. [[b]] — B (project). Latest: (no observations yet)',
  );
});
