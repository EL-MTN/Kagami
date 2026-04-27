import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject } from 'ai';
import { paths } from './paths.js';

const baseURL = process.env.LMSTUDIO_URL ?? 'http://localhost:1234/v1';
const apiKey = process.env.LMSTUDIO_API_KEY ?? 'lm-studio';
const modelName = process.env.MODEL ?? '';

if (!modelName) {
  console.warn(
    '[brainiac] MODEL is unset. Set it in .env to whatever your local server exposes.',
  );
}

// `supportsStructuredOutputs: true` makes the provider send
// `response_format: { type: "json_schema", ... }` instead of the default
// `json_object`, which LM Studio rejects with "must be 'json_schema' or 'text'".
// The option is honored at runtime but isn't in the public settings type.
const provider = createOpenAICompatible({
  name: 'lmstudio',
  baseURL,
  apiKey,
  supportsStructuredOutputs: true,
} as Parameters<typeof createOpenAICompatible>[0]);

export const model = provider(modelName);

export interface ObjectCallOptions<T extends z.ZodTypeAny> {
  stage: string;
  schema: T;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  // Mitigation knob for Gemma 4's repetition-under-grammar tendency.
  // 0 by default; 0.3–0.5 if loops are observed.
  frequencyPenalty?: number;
}

// generateObject sends the Zod schema to the provider as a JSON schema; the
// provider enforces it via constrained decoding. AI SDK validates the result
// against the same Zod schema before returning.
export async function callObject<T extends z.ZodTypeAny>(
  opts: ObjectCallOptions<T>,
): Promise<z.infer<T> | null> {
  const { stage, schema, systemPrompt, userPrompt } = opts;
  const temperature = opts.temperature ?? 0.2;
  const frequencyPenalty = opts.frequencyPenalty ?? 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { object } = await generateObject({
        model,
        schema,
        system: systemPrompt,
        prompt: userPrompt,
        temperature,
        frequencyPenalty,
      });
      return object as z.infer<T>;
    } catch (err) {
      if (attempt === 2) {
        await quarantine(stage, {
          err: String(err),
          systemPrompt,
          userPrompt,
        });
        return null;
      }
    }
  }
  return null;
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
