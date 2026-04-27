import fs from 'node:fs/promises';
import { z } from 'zod';
import { callJsonText } from './llm.js';
import { listEntityIds } from './entity_io.js';
import { entityPath, paths } from './paths.js';

export interface QueryResult {
  answer: string;
  citations: string[];
}

const QueryResponse = z.object({
  answer: z.string(),
  citations: z.array(z.string()),
});

const MAX_HITS = 10;

const SYSTEM_PROMPT = `You answer questions about the user from their personal memory vault.

The user's persistent identity is in _core.md. The vault index lists every entity. Below the index, you receive the candidate entity files surfaced by substring search.

Answer the question by citing entity files. Cite their relative paths exactly. If the candidates and _core.md don't contain the answer, say so plainly. Do not invent facts the files don't support.

Output ONLY a JSON object of this shape, no prose:

{
  "answer": "<concise answer grounded in the cited files>",
  "citations": ["entities/<id>.md", ...]
}`;

export async function query(question: string): Promise<QueryResult> {
  const core = await readSafe(paths.core, '(empty)');
  const index = await readSafe(paths.index, '(empty)');
  const hitIds = await fileSearch(question);
  const bodies = await Promise.all(
    hitIds.map(async (id) => ({
      path: `entities/${id}.md`,
      body: await fs.readFile(entityPath(id), 'utf8'),
    })),
  );

  const userPrompt = [
    `_core.md:\n\n${core.trim()}`,
    `index.md:\n\n${index.trim()}`,
    bodies.length > 0
      ? `Candidate files:\n\n${bodies
          .map((b) => `--- ${b.path} ---\n${b.body.trim()}`)
          .join('\n\n')}`
      : 'Candidate files: (no substring matches)',
    `Question: ${question}`,
  ].join('\n\n');

  const result = await callJsonText({
    stage: 'query',
    schema: QueryResponse,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
  });
  return result ?? { answer: '(no answer — LLM failure)', citations: [] };
}

async function readSafe(p: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return fallback;
  }
}

// Token-based scoring against entity file contents. ~50ms for hundreds of
// files. Replace with FTS5 when scale demands.
async function fileSearch(question: string): Promise<string[]> {
  const terms = question
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9-]/g, ''))
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [];

  const ids = await listEntityIds();
  const scored: { id: string; score: number }[] = [];
  for (const id of ids) {
    const content = (await fs.readFile(entityPath(id), 'utf8')).toLowerCase();
    let score = 0;
    for (const term of terms) {
      score += content.split(term).length - 1;
    }
    if (score > 0) scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_HITS).map((s) => s.id);
}
