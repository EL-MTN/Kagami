import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { embed, embedMany, cosineSimilarity, generateObject } from 'ai';
import { readTranscript } from './transcript.js';
import { getEmbeddingModel, model } from './llm.js';
import { paths } from './paths.js';
import {
  appendFacts,
  newFactId,
  readFacts,
  type Fact,
} from './facts.js';
import { lemmatizeForBm25 } from './text.js';
import { upsertEntitiesFromFacts } from './entities.js';

// Mem0-faithful atomic-fact extraction. Uses the verbatim
// ADDITIVE_EXTRACTION_PROMPT from mem0/configs/prompts.py (saved at
// prompts/mem0_additive_extraction.md), chunks transcripts into
// 2-message batches, looks up the top-K most-similar existing facts as
// dedup context, and persists each new fact with its embedding into
// .memory/facts.jsonl.

const BATCH_SIZE = 2;
const TOP_K_EXISTING = 10;
const RECENTLY_EXTRACTED_LIMIT = 20;
const LAST_K_MESSAGES = 20;

// Mem0's mem0_additive_extraction.md describes a richer per-memory shape
// (`attributed_to`, optional `linked_memory_ids`). We only use `text` at
// retrieval time, so the wire schema stays minimal — fewer fields means
// fewer ways for the model to fail strict structured-output validation.
const ExtractionResult = z.object({
  memory: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
});

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
  const promptPath = `${paths.prompts}/mem0_additive_extraction.md`;
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

export async function consolidate(
  transcriptPath: string,
): Promise<{ added: number; batches: number }> {
  const transcript = await readTranscript(transcriptPath);
  const sessionId = transcript.frontmatter.id;
  const sessionDate = String(transcript.frontmatter.started_at).slice(0, 10);
  const currentDate = new Date().toISOString().slice(0, 10);

  const messages: Message[] = transcript.turns.map((t) => ({
    role: normalizeRole(t.role),
    content: t.text,
  }));

  const existingFacts = await readFacts();
  // mem0/memory/main.py:Phase 5 — md5 hash dedup. Skip facts whose text
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
        user_id: 'default',
        created_at: new Date().toISOString(),
        event_date: sessionDate,
        source_session: `raw/${sessionId}`,
        hash,
        embedding: embeddings[j]!,
      });
    }

    if (facts.length === 0) continue;
    await appendFacts(facts);
    // Mem0 Phase 7: extract entities from each new fact and upsert into
    // the per-vault entity store, linking memory_ids to entities for
    // boost-at-retrieval.
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
