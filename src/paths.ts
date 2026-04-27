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
  entities: path.join(vaultRoot, 'entities'),
  core: path.join(vaultRoot, '_core.md'),
  index: path.join(vaultRoot, 'index.md'),
  internal: path.join(vaultRoot, '.memory'),
  log: path.join(vaultRoot, '.memory', 'log.jsonl'),
  llmFailures: path.join(vaultRoot, '.memory', 'llm-failures'),
  prompts: path.join(projectRoot, 'prompts'),
} as const;

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function entityPath(id: string): string {
  return path.join(paths.entities, `${id}.md`);
}

export function transcriptWikilink(transcriptId: string, turnId: string): string {
  return `[[raw/${transcriptId}#${turnId}]]`;
}
