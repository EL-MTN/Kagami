import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { generateObject, generateText, hasToolCall, stepCountIs, tool } from 'ai';
import { model } from './llm.js';
import { paths } from './paths.js';

export interface QueryResult {
  answer: string;
  citations: string[];
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

const SYSTEM_PROMPT = `You answer questions about the user from their personal memory vault.

You receive:
- _core.md: always-loaded canonical user state. If it states a current fact, USE IT DIRECTLY and call answer with citations: ["_core.md"]. Do not view further entities to "double-check" core.
- index.md: the vault's table of contents — one line per entity with id, type, name, and aliases.
- timeline.md: every observation in the vault sorted chronologically by event date. Each line is "<date> — <fact> [[<entity-id>]]". Use this for any question involving "when", "first/last", "before/after", duration, or ordering — the answer is often visible directly without viewing entities.

For anything not already in _core.md or timeline.md, call view({ path: "entities/<id>.md" }) to read entity bodies. You may call view up to ${MAX_VIEW_CALLS} times, but typically 1–3 is enough. Pick entities from index.md whose name, type, or aliases relate to the question — even loosely. Be liberal: a question about "editors" should make you check anything tool-shaped (Obsidian, etc.) even without lexical overlap.

Termination — you MUST end with exactly one of these tool calls. A bare text response counts as failure:
- answer({ answer, citations }) — when you have read enough to answer, or when _core.md / timeline.md alone contain it.
- bail({ reason }) — only for clearly off-topic questions whose subject has no entity in index.md and no fact in _core.md or timeline.md ("favorite color", "manager at work"). Do NOT bail just because the question's wording does not appear in entity names; view first.

Rules:
- Cite exact relative paths of files you actually viewed (e.g., "entities/typescript.md"), or "_core.md" / "timeline.md" when you used them. Never cite a file you did not view.
- Do not invent facts the files don't support.
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

export async function query(question: string): Promise<QueryResult> {
  const core = await readSafe(paths.core, '(empty)');
  const index = await readSafe(paths.index, '(empty)');
  const timeline = await readSafe(paths.timeline, '(empty)');

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

  const userPrompt = [
    `_core.md:\n\n${core.trim()}`,
    `index.md:\n\n${index.trim()}`,
    `timeline.md:\n\n${timeline.trim()}`,
    `Question: ${question}`,
  ].join('\n\n');

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
