import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { paths } from './paths.js';
import { consolidate } from './ingest.js';
import { query } from './query.js';
import { readFacts } from './storage/facts.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// All file operations are scoped to the vault. Resolve and reject anything that
// escapes via .. or absolute paths outside paths.vault.
function resolveInVault(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(paths.vault, p);
  const rel = path.relative(paths.vault, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the vault: ${p}`);
  }
  return abs;
}

const server = new McpServer({ name: 'brainiac', version: '0.1.0' });

server.registerTool(
  'view',
  {
    description:
      'Read a file or list a directory inside the vault. Path is vault-relative.',
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    try {
      const abs = resolveInVault(p);
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const lines = entries.map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );
        return ok(lines.join('\n'));
      }
      return ok(await fs.readFile(abs, 'utf8'));
    } catch (e) {
      return fail(String(e));
    }
  },
);

server.registerTool(
  'create',
  {
    description: 'Create a new file inside the vault. Errors if it already exists.',
    inputSchema: { path: z.string(), content: z.string() },
  },
  async ({ path: p, content }) => {
    try {
      const abs = resolveInVault(p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, { flag: 'wx' });
      return ok(`created ${p}`);
    } catch (e) {
      return fail(String(e));
    }
  },
);

server.registerTool(
  'str_replace',
  {
    description:
      'Replace one occurrence of `old` with `new` in a vault file. Errors if `old` is missing or non-unique.',
    inputSchema: {
      path: z.string(),
      old: z.string(),
      new: z.string(),
    },
  },
  async ({ path: p, old, new: replacement }) => {
    try {
      const abs = resolveInVault(p);
      const content = await fs.readFile(abs, 'utf8');
      const first = content.indexOf(old);
      if (first === -1) return fail(`old string not found in ${p}`);
      if (content.indexOf(old, first + 1) !== -1) {
        return fail(`old string is not unique in ${p}`);
      }
      const next = content.slice(0, first) + replacement + content.slice(first + old.length);
      await fs.writeFile(abs, next);
      return ok(`replaced in ${p}`);
    } catch (e) {
      return fail(String(e));
    }
  },
);

server.registerTool(
  'consolidate',
  {
    description:
      'Extract atomic facts from a transcript into the vault. Path is vault-relative (e.g. raw/2026-04-27-1430.md) or absolute. Returns {added, batches}.',
    inputSchema: { transcript_path: z.string() },
  },
  async ({ transcript_path }) => {
    try {
      const abs = path.isAbsolute(transcript_path)
        ? transcript_path
        : path.resolve(paths.vault, transcript_path);
      const result = await consolidate(abs);
      return ok(JSON.stringify(result));
    } catch (e) {
      return fail(String(e));
    }
  },
);

server.registerTool(
  'query',
  {
    description:
      'Answer a question from the memory vault using top-K atomic facts. Returns {answer, citations}.',
    inputSchema: { question: z.string() },
  },
  async ({ question }) => {
    try {
      const result = await query(question);
      return ok(JSON.stringify(result));
    } catch (e) {
      return fail(String(e));
    }
  },
);

server.registerTool(
  'fact_count',
  {
    description: 'Return the number of atomic facts currently stored in the vault.',
    inputSchema: {},
  },
  async () => {
    try {
      const facts = await readFacts();
      return ok(String(facts.length));
    } catch (e) {
      return fail(String(e));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
