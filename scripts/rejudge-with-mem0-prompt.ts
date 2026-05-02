// Re-judge an existing LongMemEval results file using mem0's permissive
// judge prompt instead of the standard LongMemEval judge. Isolates the
// judge-leniency contribution to mem0's published 88-93% headline.
//
// Usage: BENCH_RESULTS=path/to/results.json tsx scripts/rejudge-with-mem0-prompt.ts

import fs from 'node:fs/promises';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

interface JudgedItem {
  question_id: string;
  question_type: string;
  question: string;
  ground_truth: unknown;
  prediction: string;
  judge_verdict: boolean;
  judge_raw: string;
}

const MEM0_JUDGE_PROMPT = `I will give you a question, a correct answer (or rubric), and a model response. Decide whether the model response is correct.

CORE PRINCIPLE — Semantic equivalence: Judge by MEANING, not exact words. Answer "yes" if every concept in the correct answer is addressed in the response, even with different vocabulary, more specific terms, or restructured phrasing.

IMPORTANT BIAS CHECK: You have a tendency to say "no" too quickly. Before concluding "no", you MUST verify the answer is truly wrong, not just differently worded. When in doubt, lean toward "yes".

Rules:

**Equivalence & Supersets**
- Equivalent or superset responses are correct. Extra details are fine unless proven to be factually wrong. Extra qualifiers are fine unless proven to be wrong. E.g., "a blue dress and a matching necklace" is correct when the answer is "a blue dress."
- If a response captures the most specific part (exact item/place/name) but omits a broader container, it's correct.
- Same factual meaning with different phrasing = correct (e.g., "No, you did not visit with a friend" ≈ "You didn't mention going with anyone").
- Adding scope qualifiers like "regular-season" or "excluding X" is fine as long as the core value is correct. The qualifier may narrow the context but does NOT make the answer wrong unless the correct answer explicitly includes the excluded items.

**Lists & Compound Terms**
- For list answers, match each item by semantic meaning. A concept is covered if restated via synonyms, sub-concepts, or related terms. Adding methodological detail or rewording verbs to near-synonyms is acceptable.
- A broad term like "A and B significance" is covered if the response addresses the topic area through related specific terms, even without naming each component literally.
- If some items as listed as "or"s, "maybe"s and potential answers, it's okay if the answer does not include those.
- If two items in a list achieve the same purpose, listing just one of them is fine.

IMPORTANT: The "anti-preference" items are very specific!
Eg. Someone "not interested in general AI topics" could be very interested in specific AI topics in general AI *conferences*; those are not the same thing and should be accepted! topics != conferences

**Numbers & Precision**
- Hedging ("at least 3", "approximately") is fine if the core number matches. A range that includes the correct answer is correct.
Generally, if the user themself would be satisfied by the response, it is acceptable. Ie. If the answer is conditional on information they would have (eg. their birthday, some hidden dependent information), and would be correct with that information, that is acceptable.
- More precise answers are correct: "22 days" matches "3 weeks"; "over $270" matches "$270."; "9 1/2 months" matches "9 months";

- Rough answers are correct: "about nine months" ≈ "9 months; "8 months and 20 days" matches "9 months";

- Off-by-one errors on days/weeks/months are acceptable.
- Approximate unit conversions are equivalent: "14 weeks" ≈ "3 months", "6 months" ≈ "half a year."
- Round time ranges generously: 7 months and 16 days ≈ 8 months.
- Notes instead of chords are acceptable when justified
- A correct number with added context (e.g., "about 5 months ago (around December 2022)") is correct — the parenthetical date is supplementary, not a contradiction.

**Dates & Temporal**
- Date format variations are equivalent: "February 1st" = "Feb 1, 2023" = "on February 1."
- Same-day event ordering swaps are acceptable.
- Outdated info alongside the correct updated answer is acceptable if the current value is identified.
- "recent" is upto 6 years ago, which means 2017+
- References like "last weekend", "last Wednesday", etc. are imprecise - people sometimes mean the weekend/Wednesday before the latest one if they're near it. "Last 3 months" can include boundary days of the 4th month back. "Last month" includes the current month so far. Be flexible with such timestamps

**Counting Edge Cases**
- If correct answer is "0" or "nothing found," model saying "not enough information" is also correct.
- Similarly, If correct answer is "not enough information", model saying "0" or "nothing found," is also correct.

**Preference/Personalization Rubrics** (apply in order):
1. Correct if the response demonstrates awareness of user's personal context (preferences, habits, interests). Need not satisfy every rubric point.
2. Primary criterion: do main suggestions align with what the user WANTS?
3. Anti-preferences: evaluate the OVERALL thrust, not keyword scanning. If the response largely suggests correct options, minor incidental references to "not-preferred" things are fine.
4. Mentioning a phone app as a MEANS to a preferred activity (e.g., meditation app for sleep) is not "suggesting phone use." Judge by the activity, not delivery mechanism.
5. "May not prefer" = mild preference, not hard prohibition. Secondary/context-dependent inclusion is fine.
6. Explicit acknowledgment of anti-preferences (e.g., "keep screens off") strengthens correctness.
7. Context-dependent suggestions are acceptable (reading is fine on a bus even if rubric flags visual attention activities). Adjacent genres alongside preferred ones are additive, not contradictory.
8. If the rubric mentions specific user resources/tools (e.g., "Suica card", "TripIt app"), the response is correct if it demonstrates awareness of the user's MAIN personal context even if it does not name every specific tool. The rubric is a guide, not a checklist.

**Abstention Matching**
- If correct answer = unanswerable/abstention, ANY phrasing that conveys "I don't have this information" is correct, regardless of what partial context is mentioned or omitted.
- Saying "not enough information" while mentioning partial related context = correct abstention.
- Saying "no record of X" or "only have plans for X, not actual dates" = correct abstention.
- The key test: does the response REFUSE to answer the question? If yes, it matches an abstention ground truth, period.

FINAL CHECK: Before answering "no," you MUST reason through these steps:
1. What is the core factual claim or intent of the correct answer?
2. Does the model response address that same claim, even in different words?
3. Is the response a superset (correct answer + extra details)?
4. For numbers: does the core number match, ignoring hedging/qualifiers?
5. For abstentions: does the response effectively decline to answer?
Only answer "no" if, after this analysis, a core concept is entirely unaddressed or contradicted.

Question: {question}

Correct Answer: {answer}

Model Response: {response}

Think step-by-step in <judge_thinking> tags, then give your final verdict as exactly "yes" or "no" on a new line after the closing tag.`;

async function main() {
  const resultsPath = process.env.BENCH_RESULTS;
  if (!resultsPath) throw new Error('Set BENCH_RESULTS=path/to/results.json');
  const baseURL = process.env.LMSTUDIO_URL ?? 'http://localhost:1234/v1';
  const apiKey = process.env.LMSTUDIO_API_KEY ?? 'lm-studio';
  const judgeModelId = process.env.JUDGE_MODEL ?? 'gpt-4o-mini';

  const data = JSON.parse(await fs.readFile(resultsPath, 'utf8'));
  const items: JudgedItem[] = data.items;

  const provider = createOpenAICompatible({
    name: 'lmstudio',
    baseURL,
    apiKey,
    supportsStructuredOutputs: true,
  } as Parameters<typeof createOpenAICompatible>[0]);
  const judge = provider(judgeModelId);

  console.log(`# Re-judging ${items.length} predictions`);
  console.log(`Source:        ${resultsPath}`);
  console.log(`Judge model:   ${judgeModelId}`);
  console.log(`Judge prompt:  mem0 (permissive)`);
  console.log('');

  const verdicts: Array<{ qid: string; type: string; old: boolean; new: boolean }> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const truth = Array.isArray(it.ground_truth)
      ? (it.ground_truth as unknown[]).map(String).join('; ')
      : String(it.ground_truth ?? '');
    const prompt = MEM0_JUDGE_PROMPT
      .replace('{question}', it.question)
      .replace('{answer}', truth)
      .replace('{response}', it.prediction || '(no answer)');

    let raw = '';
    let verdict = false;
    try {
      const r = await generateText({
        model: judge,
        prompt,
        temperature: 0,
      });
      raw = r.text.trim();
      // Take the last non-empty line and check for "yes"
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1] ?? '';
      verdict = /^yes$/i.test(last) || /\byes\b/i.test(last);
    } catch (err) {
      raw = `(judge error: ${(err as Error).message})`;
    }
    verdicts.push({ qid: it.question_id, type: it.question_type, old: it.judge_verdict, new: verdict });
    process.stderr.write(`[${i + 1}/${items.length}] ${verdict ? 'YES' : 'no '} ${it.question_id} (was ${it.judge_verdict ? 'YES' : 'no'})\n`);
  }

  const total = verdicts.length;
  const correct = verdicts.filter((v) => v.new).length;
  const oldCorrect = verdicts.filter((v) => v.old).length;
  const flipped_to_right = verdicts.filter((v) => !v.old && v.new).length;
  const flipped_to_wrong = verdicts.filter((v) => v.old && !v.new).length;

  console.log('');
  console.log(`## Summary`);
  console.log(`accuracy (mem0 judge):     ${(correct / total * 100).toFixed(1)}%  (${correct}/${total})`);
  console.log(`accuracy (original judge): ${(oldCorrect / total * 100).toFixed(1)}%  (${oldCorrect}/${total})`);
  console.log(`flipped to right: ${flipped_to_right}`);
  console.log(`flipped to wrong: ${flipped_to_wrong}`);
  const net = flipped_to_right - flipped_to_wrong;
  console.log(`net judge effect:  ${net >= 0 ? '+' : ''}${net}`);

  // Per-type breakdown
  const types = new Map<string, { total: number; correct: number; oldCorrect: number }>();
  for (const v of verdicts) {
    if (!types.has(v.type)) types.set(v.type, { total: 0, correct: 0, oldCorrect: 0 });
    const t = types.get(v.type)!;
    t.total += 1;
    if (v.new) t.correct += 1;
    if (v.old) t.oldCorrect += 1;
  }
  console.log('');
  console.log(`per-type:`);
  for (const [type, t] of types) {
    console.log(`  ${type.padEnd(28)} mem0 ${(t.correct / t.total * 100).toFixed(1)}% (${t.correct}/${t.total})  vs original ${(t.oldCorrect / t.total * 100).toFixed(1)}% (${t.oldCorrect}/${t.total})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
