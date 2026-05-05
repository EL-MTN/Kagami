import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/api/src/paths.ts → apps/api/
export const appRoot = path.resolve(__dirname, '..');
// apps/api/ → monorepo root (the vault lives here as a sibling of apps/)
export const repoRoot = path.resolve(appRoot, '../..');

export const vaultRoot = process.env.KIOKU_VAULT
  ? path.resolve(process.env.KIOKU_VAULT)
  : path.join(repoRoot, 'memory');

export const paths = {
  vault: vaultRoot,
  raw: path.join(vaultRoot, 'raw'),
  prompts: path.join(appRoot, 'prompts'),
} as const;
