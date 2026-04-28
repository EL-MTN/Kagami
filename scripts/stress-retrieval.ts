// Retrieval stress test. Runs a battery of varied queries through query()
// against the current vault. Set MODEL before invoking, e.g.
//   MODEL=google/gemma-4-31b npx tsx scripts/stress-retrieval.ts

import { query } from '../src/query.js';

interface Probe {
  category: string;
  question: string;
  // Substrings expected to appear in the answer or citations. Empty array
  // means "no expectation" (we still record the answer).
  expect_any?: string[];
  // If set, the answer SHOULD say it doesn't know / can't find it.
  expect_unknown?: boolean;
}

const PROBES: Probe[] = [
  // Direct lookups
  { category: 'direct', question: 'What local model am I currently using?',
    expect_any: ['gemma-4-31b', 'gpt-oss-20b'] },
  { category: 'direct', question: 'Where does my memory vault live on disk?',
    expect_any: ['vault-location', 'memory'] },
  { category: 'direct', question: 'What language is Brainiac written in?',
    expect_any: ['typescript', 'TypeScript'] },

  // Alias / case sensitivity
  { category: 'alias', question: 'What is LM Studio used for in my setup?',
    expect_any: ['local-models', 'LM Studio'] },
  { category: 'alias', question: 'Tell me about Gemma 4 31B.',
    expect_any: ['gemma-4-31b'] },

  // Multi-entity synthesis
  { category: 'synthesis', question: 'Why did I migrate to the AI SDK?',
    expect_any: ['ai-sdk'] },
  { category: 'synthesis', question: 'What are my architectural beliefs about LLMs in this system?',
    expect_any: ['all-llm-or-no-llm-stance'] },
  { category: 'synthesis', question: 'How should I store memory and why?',
    expect_any: ['obsidian', 'vault-location', 'personal-memory-base'] },

  // Latency / constraints
  { category: 'constraint', question: 'What is my latency budget for queries?',
    expect_any: ['latency-budget', '2s'] },
  { category: 'constraint', question: 'How big is the GPT context window I rely on?',
    expect_any: ['gpt-context-window', 'context'] },

  // Negative / unknown
  { category: 'unknown', question: 'What is my favorite color?',
    expect_unknown: true },
  { category: 'unknown', question: 'Do I use Postgres for storage?',
    expect_unknown: true },
  { category: 'unknown', question: 'Who is my manager at work?',
    expect_unknown: true },

  // Vague / fuzzy
  { category: 'fuzzy', question: 'What am I working on?',
    expect_any: ['brainiac', 'personal-memory-base'] },
  { category: 'fuzzy', question: 'Why local-first?',
    expect_any: ['local-first'] },

  // Multi-hop
  { category: 'multihop', question: 'What model should I use given my latency budget?',
    expect_any: ['gemma', 'gpt-oss', 'latency'] },
  { category: 'multihop', question: 'What tools do I edit memory with?',
    expect_any: ['obsidian'] },
];

interface ProbeResult {
  category: string;
  question: string;
  answer: string;
  citations: string[];
  ms: number;
  pass: boolean;
  reason: string;
}

function judge(probe: Probe, answer: string, citations: string[]): { pass: boolean; reason: string } {
  const haystack = (answer + ' ' + citations.join(' ')).toLowerCase();
  if (probe.expect_unknown) {
    const unknownMarkers = ['don\'t', 'do not', 'no information', 'not in', 'cannot find', "can't find", 'no mention', 'not contain', 'no record', "isn't", 'unknown', 'not found'];
    const said = unknownMarkers.some((m) => haystack.includes(m));
    return { pass: said, reason: said ? 'said-unknown' : 'hallucinated-an-answer' };
  }
  if (!probe.expect_any || probe.expect_any.length === 0) {
    return { pass: true, reason: 'no-expectation' };
  }
  const hit = probe.expect_any.find((e) => haystack.includes(e.toLowerCase()));
  return hit
    ? { pass: true, reason: `matched:${hit}` }
    : { pass: false, reason: `missing-any-of:${probe.expect_any.join('|')}` };
}

async function main() {
  const model = process.env.MODEL ?? '(unset)';
  console.log(`# Retrieval stress test`);
  console.log(`Model: ${model}`);
  console.log(`Probes: ${PROBES.length}`);
  console.log('');

  const results: ProbeResult[] = [];
  for (let i = 0; i < PROBES.length; i++) {
    const p = PROBES[i];
    const t0 = Date.now();
    let answer = '';
    let citations: string[] = [];
    try {
      const r = await query(p.question);
      answer = r.answer;
      citations = r.citations;
    } catch (err) {
      answer = `(threw: ${String(err)})`;
    }
    const ms = Date.now() - t0;
    const { pass, reason } = judge(p, answer, citations);
    results.push({ category: p.category, question: p.question, answer, citations, ms, pass, reason });
    const tag = pass ? 'PASS' : 'FAIL';
    console.log(`[${i + 1}/${PROBES.length}] ${tag}  ${ms}ms  (${p.category})  ${p.question}`);
    console.log(`     reason: ${reason}`);
    console.log(`     answer: ${truncate(answer, 200)}`);
    console.log(`     cites:  ${citations.join(', ') || '(none)'}`);
    console.log('');
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  const avgMs = Math.round(totalMs / results.length);
  const sorted = [...results].map((r) => r.ms).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];

  console.log('## Summary');
  console.log(`pass:  ${passed}/${results.length}`);
  console.log(`fail:  ${failed}`);
  console.log(`avg:   ${avgMs}ms   p50: ${p50}ms   p95: ${p95}ms   total: ${totalMs}ms`);
  console.log('');
  console.log('## Failures');
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`- (${r.category}) ${r.question}`);
    console.log(`  reason: ${r.reason}`);
    console.log(`  answer: ${truncate(r.answer, 300)}`);
    console.log(`  cites:  ${r.citations.join(', ') || '(none)'}`);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
