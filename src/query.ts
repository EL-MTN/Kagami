import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { generateText, hasToolCall, stepCountIs, tool } from 'ai';
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

const MAX_VIEW_CALLS = 5;
const MAX_STEPS = MAX_VIEW_CALLS + 1;

const SYSTEM_PROMPT = `You answer questions about the user from their personal memory vault.

You receive:
- _core.md: always-loaded user context.
- index.md: the vault's table of contents — one line per entity with id, type, name, and aliases.

You do NOT receive entity bodies up front. To read an entity, call view({ path: "entities/<id>.md" }). You may call view up to ${MAX_VIEW_CALLS} times. Pick entities from index.md whose name, type, or aliases relate to the question — even loosely.

When you have enough context, call answer({ answer, citations }) exactly once. Do this even if you cannot answer; pass an empty citations array in that case.

Rules:
- Cite exact relative paths of files you actually viewed (e.g., "entities/typescript.md"). Never cite a file you did not view.
- Do not invent facts the files don't support. If the vault doesn't contain the answer, say so plainly in the answer field.
- Always finish by calling the answer tool. Do not produce a bare text response.`;

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

  let captured: QueryResult | null = null;
  const viewedPaths = new Set<string>();

  const view = tool({
    description: `Read a single file from the vault. Path must start with "entities/" or "raw/". Returns the file contents. Limit: ${MAX_VIEW_CALLS} calls per query.`,
    inputSchema: ViewInput,
    execute: async ({ path: rel }) => {
      if (!isVaultPath(rel)) {
        return { error: `Invalid path "${rel}". Must start with "entities/" or "raw/" and contain no ".." segments.` };
      }
      try {
        const content = await readVaultFile(rel);
        viewedPaths.add(rel);
        return { path: rel, content };
      } catch (err) {
        return { error: `Could not read "${rel}": ${(err as Error).message}` };
      }
    },
  });

  const answer = tool({
    description: 'Submit the final answer with citations. Call exactly once when ready. Citations must be paths you have viewed.',
    inputSchema: AnswerInput,
    execute: async (input) => {
      captured = input;
      return { ok: true };
    },
  });

  const userPrompt = [
    `_core.md:\n\n${core.trim()}`,
    `index.md:\n\n${index.trim()}`,
    `Question: ${question}`,
  ].join('\n\n');

  let textFallback = '';
  try {
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      tools: { view, answer },
      stopWhen: [hasToolCall('answer'), stepCountIs(MAX_STEPS)],
      temperature: 0.2,
    });
    textFallback = result.text;
  } catch (err) {
    return { answer: `(no answer — LLM failure: ${(err as Error).message})`, citations: [] };
  }

  if (captured) return captured;
  return {
    answer: textFallback || '(no answer — model did not call the answer tool)',
    citations: [],
  };
}

async function readSafe(p: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return fallback;
  }
}
