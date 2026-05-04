import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { embed, embedMany, cosineSimilarity, generateObject } from 'ai';
import { readTranscript } from './transcript.js';
import { getEmbeddingModel, model } from '../llm.js';
import { paths } from '../paths.js';
import {
  appendFacts,
  newFactId,
  readFactsInScope,
  type Fact,
} from '../storage/facts.js';
import { lemmatizeForBm25 } from '../retrieval/text.js';
import { upsertEntitiesFromFacts } from '../storage/entities.js';

// Kioku's atomic-fact extraction pipeline.
//
//   For each transcript:
//     - chunk into 2-message batches (one user + one assistant turn)
//     - look up the top-K most-similar existing facts as dedup context
//     - call the extraction prompt (prompts/extraction.md) for that batch
//     - md5-dedup each new fact against existing + within-batch hashes
//     - embed + persist surviving facts to the facts collection
//     - upsert mentioned entities into the entities collection with
//       linked fact ids for the entity-boost retrieval channel

const BATCH_SIZE = 2;
const TOP_K_EXISTING = 10;
const RECENTLY_EXTRACTED_LIMIT = 20;
const LAST_K_MESSAGES = 20;

// The extraction prompt describes a richer per-memory shape
// (`attributed_to`, optional `linked_memory_ids`). We only persist text +
// category — fewer required fields means fewer ways for the model to
// fail strict structured-output validation. category is optional on the
// wire (defaults to 'misc') so an older prompt or a confused model still
// produces parseable output.
const CATEGORIES = [
  'personal_details',
  'family',
  'professional_details',
  'sports',
  'travel',
  'food',
  'music',
  'health',
  'technology',
  'hobbies',
  'fashion',
  'entertainment',
  'milestones',
  'user_preferences',
  'misc',
] as const;
const KNOWN_CATEGORIES = new Set<string>(CATEGORIES);

const ExtractionResult = z.object({
  memory: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      category: z.string().optional(),
    }),
  ),
});

export function normalizeCategory(raw: string | undefined): string {
  if (!raw) return 'misc';
  const c = raw.trim().toLowerCase();
  return KNOWN_CATEGORIES.has(c) ? c : 'misc';
}

export const KIOKU_CATEGORIES: readonly string[] = CATEGORIES;

interface Message {
  role: string;
  content: string;
}

interface RecentFact {
  id: string;
  text: string;
  embedding: number[];
}

let cachedSystemPrompt: string | null = null;
async function getSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  const promptPath = `${paths.prompts}/extraction.md`;
  cachedSystemPrompt = await fs.readFile(promptPath, 'utf8');
  return cachedSystemPrompt;
}

function formatMessages(msgs: Message[]): string {
  if (msgs.length === 0) return '[]';
  return JSON.stringify(msgs);
}

function formatMemories(mems: Array<{ id: string; text: string }>): string {
  if (mems.length === 0) return '[]';
  return JSON.stringify(mems);
}

export function buildExtractionUserPrompt(opts: {
  newMessages: Message[];
  observationDate: string;
  currentDate: string;
  lastKMessages?: Message[];
  recentlyExtracted?: Array<{ id: string; text: string }>;
  existingMemories?: Array<{ id: string; text: string }>;
}): string {
  const sections: string[] = [];
  sections.push(`## Summary\n`);
  sections.push(
    `## Last k Messages\n${formatMessages(opts.lastKMessages ?? [])}`,
  );
  sections.push(
    `## Recently Extracted Memories\n${formatMemories(opts.recentlyExtracted ?? [])}`,
  );
  sections.push(
    `## Existing Memories\n${formatMemories(opts.existingMemories ?? [])}`,
  );
  sections.push(`## New Messages\n${formatMessages(opts.newMessages)}`);
  sections.push(`## Observation Date\n${opts.observationDate}`);
  sections.push(`## Current Date\n${opts.currentDate}`);
  sections.push('# Output:');
  return sections.join('\n\n');
}

function topKByCosine(
  qEmb: number[],
  candidates: Array<{ id: string; text: string; embedding: number[] }>,
  k: number,
): Array<{ id: string; text: string }> {
  if (candidates.length === 0) return [];
  const scored = candidates.map((c) => ({
    id: c.id,
    text: c.text,
    sim: cosineSimilarity(qEmb, c.embedding),
  }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k).map(({ id, text }) => ({ id, text }));
}

function normalizeRole(role: string): string {
  return role.toLowerCase() === 'user' ? 'user' : 'assistant';
}

export interface ConsolidateOptions {
  user_id?: string;        // defaults to 'default'
  run_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>; // applied to every fact extracted in this run
}

export async function consolidate(
  transcriptPath: string,
  opts: ConsolidateOptions = {},
): Promise<{ added: number; batches: number }> {
  const transcript = await readTranscript(transcriptPath);
  const sessionId = transcript.frontmatter.id;
  const sessionDate = String(transcript.frontmatter.started_at).slice(0, 10);
  const currentDate = new Date().toISOString().slice(0, 10);

  const userId = opts.user_id ?? 'default';
  const runId = opts.run_id;
  const agentId = opts.agent_id;
  const metadata = opts.metadata;

  const messages: Message[] = transcript.turns.map((t) => ({
    role: normalizeRole(t.role),
    content: t.text,
  }));

  // Dedup context is scoped: hash collisions and cosine-near-neighbors
  // outside this (user, run, agent) tuple don't constrain extraction here.
  const existingFacts = await readFactsInScope({
    user_id: userId,
    run_id: runId,
    agent_id: agentId,
  });
  // md5 hash dedup. Skip facts whose text
  // is byte-identical to one already on disk or seen earlier in this run.
  const seenHashes = new Set<string>(existingFacts.map((f) => f.hash));
  const recentlyExtracted: RecentFact[] = [];
  const systemPrompt = await getSystemPrompt();

  let added = 0;
  let batches = 0;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    if (batch.every((m) => !m.content.trim())) continue;
    batches += 1;

    const lastK = messages.slice(Math.max(0, i - LAST_K_MESSAGES), i);
    const batchText = batch.map((m) => m.content).join(' ');

    let batchEmb: number[];
    try {
      const r = await embed({
        model: getEmbeddingModel(),
        value: batchText,
        abortSignal: AbortSignal.timeout(15_000),
      });
      batchEmb = r.embedding;
    } catch (err) {
      console.error('[ingest] step failed:', (err as Error).message);
      continue;
    }

    const candidates = [
      ...existingFacts.map((f) => ({
        id: f.id,
        text: f.text,
        embedding: f.embedding,
      })),
      ...recentlyExtracted.map((f) => ({
        id: f.id,
        text: f.text,
        embedding: f.embedding,
      })),
    ];
    const existingMemories = topKByCosine(batchEmb, candidates, TOP_K_EXISTING);

    const userPrompt = buildExtractionUserPrompt({
      newMessages: batch,
      observationDate: sessionDate,
      currentDate,
      lastKMessages: lastK.length > 0 ? lastK : undefined,
      recentlyExtracted: recentlyExtracted
        .slice(-RECENTLY_EXTRACTED_LIMIT)
        .map(({ id, text }) => ({ id, text })),
      existingMemories,
    });

    let extraction: z.infer<typeof ExtractionResult>;
    try {
      const r = await generateObject({
        model,
        schema: ExtractionResult,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0,
        abortSignal: AbortSignal.timeout(120_000),
      });
      extraction = r.object;
    } catch (err) {
      console.error('[ingest] step failed:', (err as Error).message);
      continue;
    }

    if (extraction.memory.length === 0) continue;

    const newTexts = extraction.memory.map((m) => m.text);
    let embeddings: number[][];
    try {
      const r = await embedMany({
        model: getEmbeddingModel(),
        values: newTexts,
        maxParallelCalls: 8,
        abortSignal: AbortSignal.timeout(30_000),
      });
      embeddings = r.embeddings;
    } catch (err) {
      console.error('[ingest] step failed:', (err as Error).message);
      continue;
    }

    const facts: Fact[] = [];
    for (let j = 0; j < extraction.memory.length; j++) {
      const m = extraction.memory[j]!;
      const hash = createHash('md5').update(m.text).digest('hex');
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      facts.push({
        id: newFactId(),
        text: m.text,
        text_lemmatized: lemmatizeForBm25(m.text),
        user_id: userId,
        ...(runId !== undefined ? { run_id: runId } : {}),
        ...(agentId !== undefined ? { agent_id: agentId } : {}),
        created_at: new Date().toISOString(),
        event_date: sessionDate,
        source_session: `raw/${sessionId}`,
        hash,
        embedding: embeddings[j]!,
        ...(metadata ? { metadata } : {}),
        category: normalizeCategory(m.category),
      });
    }

    if (facts.length === 0) continue;
    await appendFacts(facts);
    // Extract entities from each new fact and upsert into the per-vault
    // entity store, linking fact ids to entities for boost-at-retrieval.
    try {
      await upsertEntitiesFromFacts(facts);
    } catch (err) {
      console.error('[ingest] entity upsert failed:', (err as Error).message);
    }
    for (const f of facts) {
      recentlyExtracted.push({
        id: f.id,
        text: f.text,
        embedding: f.embedding,
      });
    }
    added += facts.length;
  }

  return { added, batches };
}
