import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { paths } from './paths.js';

const baseURL = process.env.LMSTUDIO_URL ?? 'http://localhost:1234/v1';
const apiKey = process.env.LMSTUDIO_API_KEY ?? 'lm-studio';
const model = process.env.MODEL ?? '';

if (!model) {
  console.warn(
    '[brainiac] MODEL is unset. Set it in .env to whatever your local server exposes.',
  );
}

export const client = new OpenAI({ baseURL, apiKey });

export interface JsonCallOptions<T extends z.ZodTypeAny> {
  stage: string;
  schema: T;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export async function callJson<T extends z.ZodTypeAny>(
  opts: JsonCallOptions<T>,
): Promise<z.infer<T> | null> {
  const { stage, schema, schemaName, systemPrompt, userPrompt } = opts;
  const temperature = opts.temperature ?? 0.2;

  const params = {
    model,
    messages: [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ],
    temperature,
    response_format: {
      type: 'json_schema' as const,
      json_schema: {
        name: schemaName,
        strict: true,
        schema: zodToJsonSchema(schema),
      },
    },
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string | null = null;
    try {
      const r = (await client.chat.completions.create(
        params as unknown as Parameters<typeof client.chat.completions.create>[0],
      )) as { choices: Array<{ message: { content: string | null } }> };
      raw = r.choices[0]?.message?.content ?? null;
      if (!raw) throw new Error('empty completion');
      const parsed = JSON.parse(raw);
      return schema.parse(parsed);
    } catch (err) {
      if (attempt === 2) {
        await quarantine(stage, { err: String(err), raw, systemPrompt, userPrompt });
        return null;
      }
    }
  }
  return null;
}

export interface JsonTextCallOptions<T extends z.ZodTypeAny> {
  stage: string;
  schema: T;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

// Plain-text completion + JSON.parse. Used when json_schema mode is broken
// (e.g. gpt-oss-20b on LM Studio produces ellipsis-filled garbage in strict
// mode for nested schemas — text mode with a one-shot example works fine).
export async function callJsonText<T extends z.ZodTypeAny>(
  opts: JsonTextCallOptions<T>,
): Promise<z.infer<T> | null> {
  const { stage, schema, systemPrompt, userPrompt } = opts;
  const temperature = opts.temperature ?? 0.2;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string | null = null;
    try {
      const r = (await client.chat.completions.create({
        model,
        messages: [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userPrompt },
        ],
        temperature,
      })) as { choices: Array<{ message: { content: string | null } }> };
      raw = r.choices[0]?.message?.content ?? null;
      if (!raw) throw new Error('empty completion');
      const json = extractJson(raw);
      return schema.parse(JSON.parse(json));
    } catch (err) {
      if (attempt === 2) {
        await quarantine(stage, {
          err: String(err),
          raw,
          systemPrompt,
          userPrompt,
        });
        return null;
      }
    }
  }
  return null;
}

function extractJson(s: string): string {
  let t = s.trim();
  // Strip ``` or ```json fences.
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  // Trim any prose before the first '{' or '['.
  const obj = t.indexOf('{');
  const arr = t.indexOf('[');
  let start = -1;
  if (obj === -1) start = arr;
  else if (arr === -1) start = obj;
  else start = Math.min(obj, arr);
  if (start > 0) t = t.slice(start);
  // Trim trailing prose by walking brace/bracket depth on a string-aware scan.
  return trimToJsonEnd(t);
}

function trimToJsonEnd(s: string): string {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return s;
}

async function quarantine(stage: string, payload: unknown): Promise<void> {
  const dir = path.join(paths.llmFailures, stage);
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(
    path.join(dir, `${ts}.json`),
    JSON.stringify(payload, null, 2),
  );
}

