import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { parseMarkdown, toMarkdown } from "../utils/markdown.js";
import { logger } from "../utils/logger.js";
import type { VaultFile, SearchResult } from "./types.js";

function vaultPath(...segments: string[]): string {
  return path.resolve(config.VAULT_PATH, ...segments);
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

export async function appendToVaultFile(
  filePath: string,
  content: string,
): Promise<void> {
  const existing = await readVaultFile(filePath);
  if (existing) {
    // Line-level dedup: only add lines that aren't already present
    const existingLines = new Set(
      existing.content
        .split("\n")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
    );

    const newLines = content
      .split("\n")
      .filter((line) => {
        const normalized = line.trim().toLowerCase();
        if (!normalized) return true; // keep blank lines for formatting
        if (normalized.startsWith("#")) {
          // Keep headers only if they don't already exist
          return !existingLines.has(normalized);
        }
        return !existingLines.has(normalized);
      });

    if (newLines.every((l) => !l.trim())) {
      logger.debug({ path: filePath }, "appendToVaultFile: nothing new to add");
      return;
    }

    const updated = existing.content.trimEnd() + "\n\n" + newLines.join("\n");
    await writeVaultFile(filePath, updated, existing.frontmatter);
  } else {
    await writeVaultFile(filePath, content);
  }
}

export async function listVaultFiles(dir = ""): Promise<string[]> {
  const fullDir = vaultPath(dir);
  const results: string[] = [];

  async function walk(currentDir: string, prefix: string) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name), relative);
      } else if (entry.name.endsWith(".md")) {
        results.push(dir ? `${dir}/${relative}` : relative);
      }
    }
  }

  await walk(fullDir, "");
  return results;
}

export async function searchVault(query: string): Promise<SearchResult[]> {
  const files = await listVaultFiles();
  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();

  for (const filePath of files) {
    const file = await readVaultFile(filePath);
    if (!file) continue;

    const lines = file.content.split("\n");
    const matches: string[] = [];

    for (const line of lines) {
      if (line.toLowerCase().includes(queryLower)) {
        matches.push(line.trim());
      }
    }

    if (matches.length > 0) {
      results.push({
        path: filePath,
        matches: matches.slice(0, 5),
        score: matches.length,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
