import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, '..');

export const vaultRoot = process.env.BRAINIAC_VAULT
  ? path.resolve(process.env.BRAINIAC_VAULT)
  : path.join(projectRoot, 'memory');

export const paths = {
  vault: vaultRoot,
  raw: path.join(vaultRoot, 'raw'),
  core: path.join(vaultRoot, '_core.md'),
  internal: path.join(vaultRoot, '.memory'),
  llmFailures: path.join(vaultRoot, '.memory', 'llm-failures'),
  facts: path.join(vaultRoot, '.memory', 'facts.jsonl'),
  entities: path.join(vaultRoot, '.memory', 'entities.jsonl'),
  prompts: path.join(projectRoot, 'prompts'),
} as const;
