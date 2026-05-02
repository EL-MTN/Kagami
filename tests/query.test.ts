import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveQuestionDate,
  formatFactsGroupedByDateNewestFirst,
  stripMemThinking,
} from '../src/query.ts';
import type { RankedFact } from '../src/embeddings.ts';

const fact = (overrides: Partial<RankedFact>): RankedFact => ({
  id: 'id',
  text: 'placeholder',
  eventDate: '2024-01-01',
  sourceSession: 'raw/s',
  createdAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

test('formatFactsGroupedByDateNewestFirst groups by date, newest first', () => {
  const facts: RankedFact[] = [
    fact({ id: 'a', text: 'first', eventDate: '2024-03-01' }),
    fact({ id: 'b', text: 'middle', eventDate: '2024-02-01' }),
    fact({ id: 'c', text: 'second-on-march', eventDate: '2024-03-01' }),
  ];
  const out = formatFactsGroupedByDateNewestFirst(facts);
  assert.equal(
    out,
    '--- 2024-03-01 ---\n- first\n- second-on-march\n\n--- 2024-02-01 ---\n- middle',
  );
});

test('formatFactsGroupedByDateNewestFirst falls back to createdAt date when eventDate empty', () => {
  const facts: RankedFact[] = [
    fact({ id: 'a', text: 't1', eventDate: '', createdAt: '2024-05-04T10:00:00Z' }),
  ];
  assert.equal(
    formatFactsGroupedByDateNewestFirst(facts),
    '--- 2024-05-04 ---\n- t1',
  );
});

test('formatFactsGroupedByDateNewestFirst on empty input returns empty string', () => {
  assert.equal(formatFactsGroupedByDateNewestFirst([]), '');
});

test('stripMemThinking removes the thinking block and leading punctuation', () => {
  const raw = '<mem_thinking>scratch work...</mem_thinking>\n: The answer is 42';
  assert.equal(stripMemThinking(raw), 'The answer is 42');
});

test('stripMemThinking is a no-op when no thinking block', () => {
  assert.equal(stripMemThinking('plain answer'), 'plain answer');
});

test('stripMemThinking handles multiple thinking blocks', () => {
  const raw = '<mem_thinking>a</mem_thinking>middle<mem_thinking>b</mem_thinking>tail';
  assert.equal(stripMemThinking(raw), 'middletail');
});

test('deriveQuestionDate returns max eventDate from facts', () => {
  const facts: RankedFact[] = [
    fact({ eventDate: '2023-01-15' }),
    fact({ eventDate: '2024-06-20' }),
    fact({ eventDate: '2023-11-30' }),
  ];
  assert.equal(deriveQuestionDate(facts), '2024-06-20');
});

test('deriveQuestionDate falls back to wall clock on empty facts', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(deriveQuestionDate([]), today);
});

test('deriveQuestionDate uses createdAt when eventDate is empty', () => {
  const facts: RankedFact[] = [
    fact({ eventDate: '', createdAt: '2025-04-01T00:00:00Z' }),
  ];
  assert.equal(deriveQuestionDate(facts), '2025-04-01');
});
