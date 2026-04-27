import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { z } from 'zod';
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

async function quarantine(stage: string, payload: unknown): Promise<void> {
  const dir = path.join(paths.llmFailures, stage);
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(
    path.join(dir, `${ts}.json`),
    JSON.stringify(payload, null, 2),
  );
}

// Minimal Zod → JSON Schema for the shapes we use.
// Avoids pulling in zod-to-json-schema for the lite scope.
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray': {
      const inner = (schema as unknown as { element: z.ZodTypeAny }).element;
      return { type: 'array', items: zodToJsonSchema(inner) };
    }
    case 'ZodEnum': {
      const values = (schema as unknown as { options: string[] }).options;
      return { type: 'string', enum: values };
    }
    case 'ZodObject': {
      const shape = (schema as unknown as {
        shape: Record<string, z.ZodTypeAny>;
      }).shape;
      const properties: Record<string, object> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!(value as unknown as { isOptional: () => boolean }).isOptional()) {
          required.push(key);
        }
      }
      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    }
    case 'ZodOptional':
    case 'ZodDefault':
      return zodToJsonSchema(
        (schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType,
      );
    default:
      throw new Error(`Unsupported Zod type: ${def.typeName}`);
  }
}
