import { z } from 'zod';
import { generateObject } from 'ai';
import { model } from '../llm.js';
import { getDb } from '../storage/mongo.js';
import { logger } from '../logger.js';

// Per-session narrative summary, fed into the extraction prompt's
// `## Summary` slot. mem0 OSS uses a rolling summary that captures the
// semantic content of the conversation so far; the extractor reads it
// alongside the new message pair to ground entities and relationships.
//
// Kioku ingests a finalized transcript per consolidate() call — there is
// no in-flight conversation — so we compute a single end-to-end summary
// once at the start of consolidate() and pass that fixed string into
// every batch's prompt. Persisted in the `session_summaries` collection
// keyed by source_session so re-ingest is free.

interface SessionSummaryDoc {
  _id: string;             // source_session, e.g. "raw/answer_4be1b6b4_1"
  user_id?: string;
  run_id?: string;
  agent_id?: string;
  summary: string;
  turn_count: number;      // number of turns the summary was computed over
  created_at: string;
}

const NarrativeSummarySchema = z.object({
  summary: z
    .string()
    .describe(
      'A 4-8 sentence narrative summary of the conversation. Lead with established personal context (names, relationships, locations) and then the substantive topics covered. Past tense. No greeting, no meta-commentary.',
    ),
});

const NARRATIVE_SYSTEM = `You produce a narrative summary of a conversation transcript. The summary will be passed to a downstream memory extractor as conversational context, so its job is to ground entities and resolve references — not to enumerate facts. Capture: who the user is (name, location, relationships, profession if stated), what they were trying to accomplish, and the major topics covered. 4-8 sentences. Past tense. No greeting, no meta-commentary, no bullet points. If the transcript contains no substantive content, return an empty string.`;

const TURN_BUDGET_CHARS = 12000;

export interface SessionSummaryScope {
  user_id?: string;
  run_id?: string;
  agent_id?: string;
}

async function summariesCol() {
  const db = await getDb();
  return db.collection<SessionSummaryDoc>('session_summaries');
}

function buildSummaryUserPrompt(
  turns: Array<{ role: string; text: string }>,
): string {
  const body = turns
    .map((t) => `${t.role}: ${t.text}`)
    .join('\n')
    .slice(0, TURN_BUDGET_CHARS);
  return `Transcript:\n${body}\n\nReturn the summary field.`;
}

async function generateNarrativeSummary(
  turns: Array<{ role: string; text: string }>,
): Promise<string> {
  if (turns.length === 0) return '';
  try {
    const { object } = await generateObject({
      model,
      schema: NarrativeSummarySchema,
      system: NARRATIVE_SYSTEM,
      prompt: buildSummaryUserPrompt(turns),
      temperature: 0,
      abortSignal: AbortSignal.timeout(60_000),
    });
    return object.summary.trim();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'session narrative summary failed — extraction will proceed without one',
    );
    return '';
  }
}

// Get the cached narrative summary for this session, computing and
// persisting it on first request. Returns '' on generation failure so
// callers can degrade to the pre-summary behavior (empty `## Summary`
// slot in the extraction prompt). A re-run of consolidate() on the same
// transcript reuses the persisted summary — no second LLM call.
export async function getOrComputeSessionSummary(opts: {
  sourceSession: string;
  turns: Array<{ role: string; text: string }>;
  scope?: SessionSummaryScope;
}): Promise<string> {
  const col = await summariesCol();
  const existing = await col.findOne({ _id: opts.sourceSession });
  if (existing && existing.turn_count === opts.turns.length) {
    return existing.summary;
  }

  const summary = await generateNarrativeSummary(opts.turns);
  if (!summary) return '';

  const doc: SessionSummaryDoc = {
    _id: opts.sourceSession,
    summary,
    turn_count: opts.turns.length,
    created_at: new Date().toISOString(),
    ...(opts.scope?.user_id !== undefined ? { user_id: opts.scope.user_id } : {}),
    ...(opts.scope?.run_id !== undefined ? { run_id: opts.scope.run_id } : {}),
    ...(opts.scope?.agent_id !== undefined ? { agent_id: opts.scope.agent_id } : {}),
  };
  // upsert so a concurrent ingester that wrote first wins; we don't
  // need our value to land if someone beat us to it.
  await col.updateOne(
    { _id: opts.sourceSession },
    { $setOnInsert: doc },
    { upsert: true },
  );
  return summary;
}
