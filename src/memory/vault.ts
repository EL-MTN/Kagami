import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { parseMarkdown, toMarkdown } from "../utils/markdown.js";
import { logger } from "../utils/logger.js";
import type { VaultFile } from "./types.js";

function vaultPath(...segments: string[]): string {
  const root = path.resolve(config.VAULT_PATH);
  const resolved = path.resolve(root, ...segments);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path traversal blocked: ${segments.join("/")}`);
  }
  return resolved;
}

export async function readVaultFile(filePath: string): Promise<VaultFile | null> {
  const fullPath = vaultPath(filePath);
  try {
    const raw = await fs.readFile(fullPath, "utf-8");
    const { frontmatter, content } = parseMarkdown(raw);
    return { path: filePath, frontmatter, content };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeVaultFile(
  filePath: string,
  content: string,
  frontmatter: Record<string, unknown> = {},
): Promise<void> {
  const fullPath = vaultPath(filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const raw = toMarkdown(frontmatter, content);
  await fs.writeFile(fullPath, raw, "utf-8");
  logger.debug({ path: filePath }, "Wrote vault file");
}
