import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { generateObject, generateText, hasToolCall, stepCountIs, tool } from 'ai';
import { model } from './llm.js';
import { paths } from './paths.js';
import {
  defaultObservationRanker,
  defaultRanker,
  type ObservationRanker,
  type RankedCandidate,
  type RankedObservation,
  type Ranker,
} from './embeddings.js';

export interface QueryResult {
  answer: string;
  citations: string[];
}

export interface QueryDeps {
  rank?: Ranker;
}

const AnswerInput = z.object({
  answer: z.string(),
  citations: z.array(z.string()),
});

const ViewInput = z.object({
  path: z.string().describe('Relative path inside the vault, e.g. "entities/typescript.md".'),
});

const BailInput = z.object({
  reason: z.string().describe('One short sentence explaining why no entity in the index could plausibly answer this.'),
});

const MAX_VIEW_CALLS = 5;
const MAX_STEPS = MAX_VIEW_CALLS + 1;

// Mem0 LongMemEval-tuned answerer prompt, adapted to our agentic loop
// (view/answer/bail) and entity-vault storage. Verbatim adaptation of
// mem0ai/memory-benchmarks longmemeval/prompts.py:ANSWER_GENERATION_PROMPT.
// {{question_date}} is interpolated at query time from the latest vault date.
const SYSTEM_PROMPT = `You are a personal assistant with access to a memory vault about the user. Answer the question using information from the vault. Be direct and concise.

You receive at the start:
- _core.md: always-loaded canonical user state. If it states a current fact, USE IT DIRECTLY and call answer with citations: ["_core.md"].
- index.md: table of contents — one line per entity with id, type, name, aliases.
- timeline.md: every observation sorted chronologically by event date. Each line is "<date> — <fact> [[<entity-id>]]".

For deeper detail, call view({ path: "entities/<id>.md" }) — up to ${MAX_VIEW_CALLS} times. Pick entities from index.md whose name, type, or aliases relate to the question — even loosely.

Pre-ranked candidates (when present): top entities by semantic similarity. Hint, not constraint.

Termination — you MUST end with exactly one of these tool calls:
- answer({ answer, citations }) — when you have enough.
- bail({ reason }) — only when the topic is genuinely unmentioned in the vault.

IMPORTANT: All relative time expressions MUST be computed relative to today's date (provided in the user prompt).

IMPORTANT: If observations indicate the user wants to avoid something, your answer must NOT contain it — not as primary, secondary, or context.

IMPORTANT: If the vault contains the numbers needed to compute the answer (ages to subtract, prices, dates to diff), DO the computation. NEVER bail when the raw data exists — even scattered across different observations or entities.

IMPORTANT: Keep answers short. No need to go into too much detail. You can describe events and ideas abstractly.

IMPORTANT: Pay close attention to the EXACT entity in the question. If the question asks about a specific variant and the vault only mentions a DIFFERENT variant (e.g., "electric guitar" vs "acoustic guitar"), bail — these are different things.

IMPORTANT: For comparison/savings questions, BOTH costs must come from USER-stated facts. Do NOT use assistant-provided general info. If only one side has a user-stated cost, bail.

IMPORTANT: If the query uses a specific but WRONG role/title/entity (e.g., asks about experience as a "Sales Manager" but vault says "Senior Sales Engineer"), do NOT answer as if they match — bail. Lean toward bail in these cases.

Before answering, reason step-by-step internally:
- List every relevant observation; list ALL observations relevant to what the user wants. Eg. for a query about paying someone, list every payment-management entity; for a travel query, list every travel-management entity.
- For counting: enumerate each item with date. Apply the question's EXACT verb/qualifier strictly (e.g., "LED" = leader only, "BAKED" = completed baking only, "COMPLETED writing" = each distinct finished piece). Count multiple items in a single observation separately. Do a SECOND scan of the timeline after initial count — items late in the timeline are commonly missed. Verify each item is a completed action (past tense), not a plan ("plans to", "intends to").
- For cross-topic computation: scan ALL entities for each needed fact independently — they're often in unrelated conversations. List: (a) what you need, (b) where each appears, (c) the computation.
- For temporal questions: identify dates, compute intervals from today's date.
- CONTEXT CHECK: Before using a value, verify it applies to the SAME context as the question. A wake-up time "while traveling" is NOT the same as a regular weekday wake-up. Always prefer the more specific observation that matches the question's context.
- For time-bounded counting: compute the INCLUSIVE date window first, then check EVERY observation's date. Err on inclusion for ambiguous dates.
- For "where is X": trace location chronologically through the timeline.
- For suggestions: list (a) what user has/does, (b) what they avoid/dislike, (c) what they want to explore. Check every suggestion against (b) before including.

Rules:

1. **Always try to answer**: If the topic appears in any observation — even indirectly — answer using what you have. Don't refuse for one missing detail.

2. **Most recent wins**: For conflicting values of the same fact, use the most recent observation (by event_date, falling back to date). But: (a) observations about different people/contexts aren't conflicting; (b) for historical event dates, use the observation recorded closest to the event; (c) for current counts/scores/status, the latest value REPLACES all earlier ones — don't sum or average. When two numbers exist for the same metric on the same date (e.g., "1,250 followers" and "close to 1,300 followers"), treat the HIGHER/UPDATED value as current.

3. **Time-bounded questions**: Compute the date window from today's date. Show date arithmetic mentally. Scan EVERY observation in range. "Last weekend" is imprecise — could mean up to 10 days ago. "Last 3 months" can include boundary days of the 4th month back. "Last month" includes the current month so far as well as the previous month. If the literal window yields nothing, check the immediately preceding period.

4. **Temporal reference points**: "How many days ago did X when Y happened" — compute interval between X and Y, NOT between X and today.

5. **Counting and ordering**: Scan ALL observations first to last in the timeline. Build a numbered list mentally with date and position. Deduplicate by matching dates/descriptions. Count items in a single observation separately. Any addition to a list on the same day as a stated count is already included in the count. When counting all instances *before* a specific event, do not include the specific event itself.

6. **Use only the vault**: Don't invent numbers, prices, or addresses.

7. **When to bail**: bail (with reason) when:
   - The topic is genuinely unmentioned in the vault.
   - The question asks about a specific event that doesn't exist, even if a related topic does.
   - The query uses a specific but WRONG role/title/entity. Lean toward bail.
   - For comparison/ordering, BOTH items must be present as completed events. If one didn't happen, bail.
   - Before bailing, scan the timeline (it's chronological, not relevance-sorted — check every line). Only bail if NO observations match the topic.
   - EXCEPTIONS: For suggestion questions, don't bail for lack of real-time info — recommend based on known preferences. If you lack exact brand but have the store, output the store.

8. **Yes/no and comparison**: "Did I ever do X?" with no matching observation = "No." For comparisons, find both values across all observations and compare directly.

9. **Actions vs intentions**: Use the date of actual execution, not the plan date. "Decided to" or "took X for servicing" = action initiated. Only treat as plan if explicit future-tense ("plans to", "will"). A plan with a specified date and no update = assume completed on that date. If a later observation confirms execution, use the execution date — it supersedes the earlier plan. When a query asks "when I decided to do X", they're asking when X was actually done.

10. **User facts vs assistant advice**: Observation quotes from the user = actual experience. Quotes from the assistant = advice. Prefer user-stated facts for personal questions. Don't convert currencies unless user stated the conversion.

11. **Connect observations across topics**: Facts needed for computation are often in unrelated entities (age in travel advice + relative's age in birthday discussion; cashback rate in membership talk + purchase amount in expense tracking). Search ALL entities for each fact independently.

12. **Personalization**: For suggestions/recommendations:
   - Prioritize personal preferences over informational content.
   - Apply known preferences to new contexts — don't bail for unfamiliar destinations.
   - Acknowledge prior work before suggesting next steps.
   - Respect anti-preferences — check every suggestion against known dislikes.
   - Reference existing tools owned, not to acquire.
   - Lead with personalization.
   - Scan ALL viewed entities for user-owned tools, apps, and resources relevant to the question; mention ALL of them.

13. **Reasonable deduction**: Infer from patterns. Assume similar items referenced in the same sentence have the same type. If the user is watching the 11th episode of a series normally, assume they completed earlier episodes. If you lack a name but have a description, answer with the description.

14. **Direct contradictions**: If two observations directly contradict (not just an update, a direct contradiction), assume the later one is true. If on the same day, trust the later time.

# Misc rules
- Class projects count as projects.
- Most old (ancestral, vintage, heritage) items count as antiques.
- If you don't have chords for a song but have notes, output the notes — song notes count as chord progressions.
- Starting a diorama project (eg. diorama work, working on terrain) counts as working on that model kit; they're equivalent.
- Running into someone at a coffee shop and exchanging numbers does NOT count as meeting them; lunch meetings do.
- Potlucks/feasts/birthday parties count as dinner parties (BBQ doesn't).
- Chandelier counts as jewelry.
- Birthdays cleanly follow years. User was 22 in 2022 → 23 in 2023.
- "Scratch grains" count as "new layer feed".

Citations:
- Cite exact relative paths of files you actually viewed (e.g., "entities/typescript.md"), or "_core.md" / "timeline.md" when you used them. Never cite a file you did not view.
- After 2–3 view calls, commit to an answer with what you have. Don't keep viewing.`;

const FALLBACK_SYSTEM_PROMPT = `Answer the question using only the provided _core.md and viewed file contents. Cite the exact paths of files you reference. If the content does not contain the answer, say so plainly with empty citations.`;

export function isVaultPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.includes('..') || rel.startsWith('/') || rel.includes('\0')) return false;
  return rel.startsWith('entities/') || rel.startsWith('raw/');
}

export async function readVaultFile(rel: string): Promise<string> {
  const abs = path.join(paths.vault, rel);
  return fs.readFile(abs, 'utf8');
}

export function formatRankedSection(candidates: RankedCandidate[]): string {
  return candidates
    .map((c, i) => {
      const headline = c.latestHeadline || '(no observations yet)';
      return `${i + 1}. [[${c.id}]] — ${c.name} (${c.type}). Latest: ${headline}`;
    })
    .join('\n');
}

// Derive "today" for relative-date arithmetic. Uses the maximum YYYY-MM-DD
// found in timeline.md (i.e. the latest known event), falling back to wall
// clock if the vault is empty. Matches mem0's `question_date` semantics.
export function deriveQuestionDate(timeline: string): string {
  const matches = timeline.match(/^- (\d{4}-\d{2}-\d{2})/gm) ?? [];
  if (matches.length === 0) return new Date().toISOString().slice(0, 10);
  let max = '0000-00-00';
  for (const m of matches) {
    const d = m.slice(2);
    if (d > max) max = d;
  }
  return max;
}

export function buildUserPrompt(
  core: string,
  index: string,
  timeline: string,
  question: string,
  rankedSection: string,
  questionDate: string,
): string {
  const parts = [
    `Today's date is ${questionDate}. Resolve all relative time expressions ("yesterday", "last month", "two months ago") against this date.`,
    `_core.md:\n\n${core.trim()}`,
    `index.md:\n\n${index.trim()}`,
  ];
  if (rankedSection) {
    parts.push(
      `Pre-ranked candidates (semantic match on the question):\n\n${rankedSection}`,
    );
  }
  parts.push(`timeline.md:\n\n${timeline.trim()}`);
  parts.push(`Question: ${question}`);
  return parts.join('\n\n');
}

export async function query(
  question: string,
  deps: QueryDeps = {},
): Promise<QueryResult> {
  const core = await readSafe(paths.core, '(empty)');
  const index = await readSafe(paths.index, '(empty)');
  const timeline = await readSafe(paths.timeline, '(empty)');

  // Embedding-based pre-ranking is opt-in. The 100-item LongMemEval gate
  // showed it as essentially flat (+2 vs the same-code baseline, with 16
  // previously-correct answers flipping wrong and 18 flipping right) — well
  // short of the +5 threshold the plan required to ship default-on. Keep
  // the wiring so it can be re-enabled per-query (or via env) if the answerer
  // model or vault size changes the picture.
  const enabled = deps.rank !== undefined || process.env.BRAINIAC_PRERANK === '1';
  let rankedSection = '';
  if (enabled) {
    const ranker = deps.rank ?? defaultRanker;
    try {
      const candidates = await ranker(question, 8);
      if (candidates.length > 0) rankedSection = formatRankedSection(candidates);
    } catch {
      rankedSection = '';
    }
  }

  let captured: QueryResult | null = null;
  const viewed = new Map<string, string>();

  const view = tool({
    description: `Read a single file from the vault. Path must start with "entities/" or "raw/". Returns the file contents. Limit: ${MAX_VIEW_CALLS} calls per query.`,
    inputSchema: ViewInput,
    execute: async ({ path: rel }) => {
      if (!isVaultPath(rel)) {
        return { error: `Invalid path "${rel}". Must start with "entities/" or "raw/" and contain no ".." segments.` };
      }
      try {
        const content = await readVaultFile(rel);
        viewed.set(rel, content);
        return { path: rel, content };
      } catch (err) {
        return { error: `Could not read "${rel}": ${(err as Error).message}` };
      }
    },
  });

  const answer = tool({
    description: 'Submit the final answer with citations. Call exactly once when ready. Citations must be paths you have viewed (or "_core.md").',
    inputSchema: AnswerInput,
    execute: async (input) => {
      captured = input;
      return { ok: true };
    },
  });

  const bail = tool({
    description: 'Abort early when index.md and _core.md have no information about the question. Faster than calling answer with empty citations. Do NOT use this just because the question wording does not appear in entity names.',
    inputSchema: BailInput,
    execute: async ({ reason }) => {
      captured = { answer: `No information in the vault: ${reason}`, citations: [] };
      return { ok: true };
    },
  });

  const questionDate = deriveQuestionDate(timeline);
  const userPrompt = buildUserPrompt(core, index, timeline, question, rankedSection, questionDate);

  let textFallback = '';
  try {
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      tools: { view, answer, bail },
      stopWhen: [hasToolCall('answer'), hasToolCall('bail'), stepCountIs(MAX_STEPS)],
      temperature: 0.2,
    });
    textFallback = result.text;
  } catch (err) {
    return { answer: `(no answer — LLM failure: ${(err as Error).message})`, citations: [] };
  }

  if (captured) return captured;

  // Safety net: model exhausted steps or returned text without calling
  // answer/bail. Synthesize a structured answer from _core.md + timeline.md +
  // whatever entities it did view.
  return await synthesizeFallback(question, core, timeline, viewed, textFallback);
}

async function synthesizeFallback(
  question: string,
  core: string,
  timeline: string,
  viewed: Map<string, string>,
  modelText: string,
): Promise<QueryResult> {
  const viewedSection =
    viewed.size > 0
      ? Array.from(viewed.entries())
          .map(([p, c]) => `--- ${p} ---\n${c.trim()}`)
          .join('\n\n')
      : '(no files viewed)';

  const prompt = [
    `_core.md:\n\n${core.trim()}`,
    `timeline.md:\n\n${timeline.trim()}`,
    `Viewed files:\n\n${viewedSection}`,
    `Question: ${question}`,
  ].join('\n\n');

  try {
    const result = await generateObject({
      model,
      schema: AnswerInput,
      system: FALLBACK_SYSTEM_PROMPT,
      prompt,
      temperature: 0.2,
    });
    return result.object;
  } catch {
    return {
      answer: modelText || '(no answer — model exhausted steps without finalizing)',
      citations: [],
    };
  }
}

async function readSafe(p: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// queryFlat — single-shot answerer with mem0-style atomic-fact retrieval.
//
// Bypasses the agentic view-loop: ranks every observation in the vault by
// cosine similarity to the question, takes the top-K, and feeds them as a
// flat list to a single generateObject call. Mirrors the architecture mem0
// uses on LongMemEval (top-K=20–50 ranked memories → single answer).
//
// Enabled via deps.observationRank (tests) or BRAINIAC_FLAT=1 env (bench).
// Lives alongside query() so we can A/B without breaking the agentic path.
// ---------------------------------------------------------------------------

const FLAT_TOP_K = Number.parseInt(process.env.BRAINIAC_FLAT_K ?? '20', 10);

const FLAT_SYSTEM_PROMPT = `You answer questions about the user from their personal memory vault. You receive _core.md (canonical user state) and the top observations retrieved by semantic similarity to the question, formatted as "<event_date>: <headline> [[entity-id]]".

IMPORTANT: All relative time expressions MUST be computed relative to today's date (provided in the user prompt).

IMPORTANT: If observations contradict, prioritize the most recent (by event_date). The vault keeps both for audit; the answer reflects the latest.

IMPORTANT: If observations contain numbers needed to compute the answer (ages to subtract, dates to diff, prices), DO the computation. Don't refuse just because the answer requires arithmetic.

IMPORTANT: If the topic is genuinely unmentioned, answer "The information provided is not enough." For comparison questions, BOTH items must appear as completed events; otherwise answer that there's not enough information.

IMPORTANT: Keep answers under 10 words unless the question demands a list. Cite the entity wikilinks ([[entity-id]]) of the observations you actually used as the citations array.

For temporal questions: identify the relevant observation's event_date, compute the interval from today.
For yes/no: "Did I ever do X?" with no matching observation = "No."
For "most recent" of a changing fact: use the latest event_date.

Output a single JSON object with shape { answer: string, citations: string[] }.`;

export interface QueryFlatDeps {
  observationRank?: ObservationRanker;
  topK?: number;
}

export function formatObservations(obs: RankedObservation[]): string {
  return obs
    .map((o) => {
      const date = o.eventDate || o.date;
      return `${date}: ${o.headline} [[${o.entityId}]]`;
    })
    .join('\n');
}

export async function queryFlat(
  question: string,
  deps: QueryFlatDeps = {},
): Promise<QueryResult> {
  const core = await readSafe(paths.core, '(empty)');
  const timeline = await readSafe(paths.timeline, '');
  const ranker = deps.observationRank ?? defaultObservationRanker;
  const k = deps.topK ?? FLAT_TOP_K;

  let observations: RankedObservation[] = [];
  try {
    observations = await ranker(question, k);
  } catch (err) {
    console.error(`[brainiac] observation ranker failed: ${(err as Error).message}`);
  }

  const questionDate = deriveQuestionDate(timeline);
  const userPrompt = [
    `Today's date is ${questionDate}.`,
    `_core.md:\n\n${core.trim()}`,
    `Top ${observations.length} observations (semantic match on the question):\n\n${
      observations.length > 0 ? formatObservations(observations) : '(none)'
    }`,
    `Question: ${question}`,
  ].join('\n\n');

  try {
    const result = await generateObject({
      model,
      schema: AnswerInput,
      system: FLAT_SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0,
    });
    return result.object;
  } catch (err) {
    return {
      answer: `(no answer — flat query failed: ${(err as Error).message})`,
      citations: [],
    };
  }
}
