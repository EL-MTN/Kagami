import fs from "node:fs/promises";
import { z } from "zod";
import { embed, embedMany, cosineSimilarity, generateObject } from "ai";
import type { Transcript } from "../types.js";
import { getEmbeddingModel, model } from "../llm.js";
import { paths } from "../paths.js";
import { appendFacts, newFactId, readFactsInScope, type Fact } from "../storage/facts.js";
import { lemmatizeForBm25 } from "../retrieval/text.js";
import { upsertEntitiesFromFacts } from "../storage/entities.js";
import { getOrComputeSessionSummary } from "./session-summary.js";
import { normalizeCategory } from "./categories.js";
import { filterDurableFacts } from "./relevance.js";
import { logger } from "../logger.js";

// Kioku's atomic-fact extraction pipeline.
//
//   For each transcript:
//     - chunk into 2-message batches (one user + one assistant turn)
//     - look up the top-K most-similar existing facts as dedup context
//     - call the extraction prompt (prompts/extraction.md) for that batch
//     - embed each new fact and cosine-dedup it against existing in-scope
//       facts, prior batches' extractions, and earlier-accepted facts in
//       this batch (NEAR_DUPE_COSINE = 0.92)
//     - persist surviving facts to the facts collection
//     - upsert mentioned entities into the entities collection with
//       linked fact ids for the entity-boost retrieval channel

const BATCH_SIZE = 2;
const TOP_K_EXISTING = 10;
const RECENTLY_EXTRACTED_LIMIT = 20;
const LAST_K_MESSAGES = 20;
// Cosine threshold for dedup at the consolidate layer. Matches
// append.ts's 0.97. The original 0.92 (chosen on the assumption that
// LLM batch extraction would produce sloppier near-duplicates) over-
// merged on LongMemEval — multi-session recall dropped 7.5pp and
// temporal-reasoning 5pp — because legitimately distinct facts about
// the same entity often land at 0.92–0.96 cosine even when their
// content is materially different.
const NEAR_DUPE_COSINE = 0.97;

// The extraction prompt describes a richer per-memory shape
// (`attributed_to`, optional `linked_memory_ids`). We only persist text +
// category. Every property in this schema must be required because
// OpenAI's strict json_schema mode rejects a `properties` map that
// doesn't list each key in `required`. category is therefore required
// on the wire; normalizeCategory clamps unknown / empty values to 'misc'
// so a confused model still produces a usable category tag.
const ExtractionResult = z.object({
  memory: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      category: z.string(),
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
  const promptPath = `${paths.prompts}/extraction.md`;
  cachedSystemPrompt = await fs.readFile(promptPath, "utf8");
  return cachedSystemPrompt;
}

function formatMessages(msgs: Message[]): string {
  if (msgs.length === 0) return "[]";
  return JSON.stringify(msgs);
}

function formatMemories(mems: Array<{ id: string; text: string }>): string {
  if (mems.length === 0) return "[]";
  return JSON.stringify(mems);
}

export function buildExtractionUserPrompt(opts: {
  newMessages: Message[];
  observationDate: string;
  currentDate: string;
  lastKMessages?: Message[];
  recentlyExtracted?: Array<{ id: string; text: string }>;
  existingMemories?: Array<{ id: string; text: string }>;
  summary?: string;
}): string {
  const sections: string[] = [];
  sections.push(`## Summary\n${opts.summary ?? ""}`);
  sections.push(`## Last k Messages\n${formatMessages(opts.lastKMessages ?? [])}`);
  sections.push(`## Recently Extracted Memories\n${formatMemories(opts.recentlyExtracted ?? [])}`);
  sections.push(`## Existing Memories\n${formatMemories(opts.existingMemories ?? [])}`);
  sections.push(`## New Messages\n${formatMessages(opts.newMessages)}`);
  sections.push(`## Observation Date\n${opts.observationDate}`);
  sections.push(`## Current Date\n${opts.currentDate}`);
  sections.push("# Output:");
  return sections.join("\n\n");
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
  return role.toLowerCase() === "user" ? "user" : "assistant";
}

export interface ConsolidateOptions {
  user_id?: string; // defaults to 'default'
  run_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>; // applied to every fact extracted in this run
}

export async function consolidate(
  transcript: Transcript,
  opts: ConsolidateOptions = {},
): Promise<{ added: number; batches: number }> {
  const sessionId = transcript.frontmatter.id;
  const sessionDate = String(transcript.frontmatter.started_at).slice(0, 10);
  const currentDate = new Date().toISOString().slice(0, 10);

  const userId = opts.user_id ?? "default";
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

  // Rolling session summary, fed into every batch's `## Summary` slot.
  // One LLM call per consolidate() run (cached on re-ingest), grounding
  // entities and references for the per-batch extractor.
  const sessionSummary = await getOrComputeSessionSummary({
    sourceSession: `raw/${sessionId}`,
    turns: messages.map((m) => ({ role: m.role, text: m.content })),
    scope: { user_id: userId, run_id: runId, agent_id: agentId },
  });
  // Cosine dedup against existing in-scope facts and prior batches'
  // extractions in this run. Within-batch dedup happens inline below
  // against `facts` as it grows.
  const recentlyExtracted: RecentFact[] = [];
  const systemPrompt = await getSystemPrompt();

  let added = 0;
  let batches = 0;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    if (batch.every((m) => !m.content.trim())) continue;
    batches += 1;

    const lastK = messages.slice(Math.max(0, i - LAST_K_MESSAGES), i);
    const batchText = batch.map((m) => m.content).join(" ");

    let batchEmb: number[];
    try {
      const r = await embed({
        model: getEmbeddingModel(),
        value: batchText,
        abortSignal: AbortSignal.timeout(15_000),
      });
      batchEmb = r.embedding;
    } catch (error) {
      logger.error(
        { error, sessionId, userId, runId, agentId, batch: batches },
        "ingest batch embed failed",
      );
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
      summary: sessionSummary || undefined,
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
    } catch (error) {
      logger.error(
        { error, sessionId, userId, runId, agentId, batch: batches },
        "ingest extraction failed",
      );
      continue;
    }

    if (extraction.memory.length === 0) continue;

    // Deterministic post-extraction clip of low-value / non-durable
    // memories (greetings, affection, assistant self-narration). The
    // extraction prompt biases against these but a stochastic model
    // still emits them on casual chat; see ingest/relevance.ts. Default
    // keep, benchmark-safe by the tests/relevance.test.ts contract.
    const { kept: memory, dropped } = filterDurableFacts(extraction.memory);
    if (dropped.length > 0) {
      logger.info(
        {
          sessionId,
          userId,
          runId,
          agentId,
          batch: batches,
          dropped: dropped.length,
          kept: memory.length,
        },
        "ingest relevance filter dropped low-value memories",
      );
    }
    if (memory.length === 0) continue;

    const newTexts = memory.map((m) => m.text);
    let embeddings: number[][];
    try {
      const r = await embedMany({
        model: getEmbeddingModel(),
        values: newTexts,
        maxParallelCalls: 8,
        abortSignal: AbortSignal.timeout(30_000),
      });
      embeddings = r.embeddings;
    } catch (error) {
      logger.error(
        { error, sessionId, userId, runId, agentId, batch: batches },
        "ingest fact embed failed",
      );
      continue;
    }

    const facts: Fact[] = [];
    for (let j = 0; j < memory.length; j++) {
      const m = memory[j]!;
      const newEmb = embeddings[j]!;

      // Skip if this fact is cosine-near-dup of (a) any existing in-scope
      // fact, (b) any fact extracted in an earlier batch of this run, or
      // (c) any fact already accepted earlier in this batch. The third
      // case is the LLM emitting paraphrased duplicates within a single
      // extraction call — a real failure mode the prompt edit mitigates
      // but does not eliminate.
      const isDupe =
        existingFacts.some((f) => cosineSimilarity(newEmb, f.embedding) >= NEAR_DUPE_COSINE) ||
        recentlyExtracted.some((f) => cosineSimilarity(newEmb, f.embedding) >= NEAR_DUPE_COSINE) ||
        facts.some((f) => cosineSimilarity(newEmb, f.embedding) >= NEAR_DUPE_COSINE);
      if (isDupe) continue;

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
        embedding: newEmb,
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
    } catch (error) {
      logger.error(
        { error, sessionId, userId, runId, agentId, batch: batches },
        "ingest entity upsert failed",
      );
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
