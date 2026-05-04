import { z } from 'zod';
import { generateObject } from 'ai';
import { parseTranscript } from './transcript.js';
import { consolidate } from './consolidate.js';
import { appendSingleFact } from './append.js';
import { model } from '../llm.js';
import { paths } from '../paths.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';

// Session ingest. Accepts a raw transcript string (matter front-matter
// + `## t-N <role>` headings, same shape as raw/<session>.md), runs the
// existing transcript-batch fact extraction, and additionally generates
// a single rolled-up session-summary fact ("On <date>, conversation
// covered <topics>.") so retrieval surfaces session-level context
// alongside the atomic facts.
//
// Concurrent callers are safe: writes go through appendFacts (unique-hash
// dedup) and upsertEntitiesFromFacts (atomic per-entity upserts).

const SummarySchema = z.object({
  topics: z
    .string()
    .describe(
      'A short comma-separated list of the substantive topics the conversation covered. No filler; no leading verb.',
    ),
});

const SUMMARY_SYSTEM = `You summarize a conversation transcript into one short, search-friendly clause naming the substantive topics that were discussed. The clause is going to be embedded as one fact in a memory store, so optimize for keyword recall: pick concrete nouns and proper nouns from the conversation. No commentary, no greeting, no narrative. Just the topics, comma-separated.`;

function buildSummaryPrompt(turns: Array<{ role: string; text: string }>): string {
  const body = turns
    .map((t) => `${t.role}: ${t.text}`)
    .join('\n')
    .slice(0, 12000); // hard cap so giant transcripts don't blow the context
  return `Transcript:\n${body}\n\nReturn the topics field.`;
}

async function generateSummaryClause(
  turns: Array<{ role: string; text: string }>,
): Promise<string | null> {
  if (turns.length === 0) return null;
  try {
    const { object } = await generateObject({
      model,
      schema: SummarySchema,
      system: SUMMARY_SYSTEM,
      prompt: buildSummaryPrompt(turns),
      temperature: 0,
      abortSignal: AbortSignal.timeout(60_000),
    });
    return object.topics.trim() || null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'summary clause generation failed',
    );
    return null;
  }
}

export interface IngestSessionInput {
  transcript: string;        // raw markdown body (frontmatter + turns)
  generateSummary?: boolean; // default true
}

export interface IngestSessionResult {
  sessionId: string;
  added: number;
  batches: number;
  summaryFactId: string | null;
}

export async function ingestSessionFromString(
  input: IngestSessionInput,
): Promise<IngestSessionResult> {
  const parsed = parseTranscript(input.transcript);
  const sessionId = parsed.frontmatter.id;
  const sessionDate = String(parsed.frontmatter.started_at).slice(0, 10);

  // The existing consolidate() expects a file path; persist the raw
  // transcript into the vault's raw/ directory (idempotent — reuses
  // an existing file if it already matches) so the standard ingest
  // pipeline runs unchanged and `source_session` resolves correctly
  // for every fact extracted from this session.
  const rawPath = path.join(paths.raw, `${sessionId}.md`);
  await fs.mkdir(paths.raw, { recursive: true });
  await fs.writeFile(rawPath, input.transcript);

  const { added, batches } = await consolidate(rawPath);

  let summaryFactId: string | null = null;
  if (input.generateSummary !== false) {
    const topics = await generateSummaryClause(
      parsed.turns.map((t) => ({ role: t.role, text: t.text })),
    );
    if (topics) {
      const summaryText = `On ${sessionDate}, conversation covered: ${topics}.`;
      const r = await appendSingleFact({
        text: summaryText,
        event_date: sessionDate,
        source_session: `raw/${sessionId}`,
      });
      // If a summary for this session already exists (re-ingest), the
      // hash dedup short-circuits and we surface the existing id.
      summaryFactId = r.id;
    }
  }

  return { sessionId, added, batches, summaryFactId };
}
