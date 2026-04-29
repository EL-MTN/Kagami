import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import {
  EntityFrontmatter,
  type Observation,
} from './types.js';
import { entityPath, paths } from './paths.js';

const OBS_HEADING = '## Observations';
const ENTITY_TEMPLATE = `\n## About\n\n${OBS_HEADING}\n`;

export interface EntityFile {
  frontmatter: EntityFrontmatter;
  body: string;
  path: string;
}

export async function entityExists(id: string): Promise<boolean> {
  try {
    await fs.access(entityPath(id));
    return true;
  } catch {
    return false;
  }
}

export async function readEntity(id: string): Promise<EntityFile> {
  const file = entityPath(id);
  const raw = await fs.readFile(file, 'utf8');
  const { data, content } = matter(raw);
  return {
    frontmatter: EntityFrontmatter.parse(data),
    body: content,
    path: file,
  };
}

export async function createEntity(fm: EntityFrontmatter): Promise<EntityFile> {
  await fs.mkdir(paths.entities, { recursive: true });
  const content = matter.stringify(ENTITY_TEMPLATE, fm);
  const file = entityPath(fm.id);
  await fs.writeFile(file, content);
  return { frontmatter: fm, body: ENTITY_TEMPLATE, path: file };
}

export async function appendObservation(
  id: string,
  obs: Observation,
): Promise<void> {
  const { frontmatter, body, path: file } = await readEntity(id);
  const idx = body.indexOf(OBS_HEADING);
  if (idx === -1) {
    throw new Error(`Entity ${id} has no '${OBS_HEADING}' section`);
  }
  const insertAt = idx + OBS_HEADING.length;
  const rendered = '\n\n' + renderObservation(obs);
  const newBody = body.slice(0, insertAt) + rendered + body.slice(insertAt);

  const updated: EntityFrontmatter = {
    ...frontmatter,
    updated: obs.date,
  };
  await fs.writeFile(file, matter.stringify(newBody, updated));
}

export async function unionAliases(id: string, more: string[]): Promise<void> {
  const { frontmatter, body, path: file } = await readEntity(id);
  const set = new Set(frontmatter.aliases);
  let changed = false;
  for (const a of more) {
    if (!set.has(a)) {
      set.add(a);
      changed = true;
    }
  }
  if (!changed) return;
  const next: EntityFrontmatter = {
    ...frontmatter,
    aliases: [...set],
  };
  await fs.writeFile(file, matter.stringify(body, next));
}

export async function listEntityIds(): Promise<string[]> {
  await fs.mkdir(paths.entities, { recursive: true });
  const files = await fs.readdir(paths.entities);
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

export async function findByNameOrAlias(
  needle: string,
): Promise<EntityFrontmatter[]> {
  const target = needle.trim().toLowerCase();
  if (!target) return [];

  const ids = await listEntityIds();
  const matches: EntityFrontmatter[] = [];
  for (const id of ids) {
    const { frontmatter } = await readEntity(id);
    const haystack = [frontmatter.name, ...frontmatter.aliases].map((s) =>
      s.trim().toLowerCase(),
    );
    if (haystack.includes(target)) matches.push(frontmatter);
  }
  return matches;
}

// Merge `from` into `to`: union aliases, append from's observations to top of
// to's, delete from's file, rewrite wikilinks vault-wide. Manual de-dup.
export async function mergeEntities(
  fromId: string,
  toId: string,
): Promise<{ observations_moved: number; wikilinks_rewritten: number }> {
  if (fromId === toId) throw new Error('cannot merge entity with itself');

  const from = await readEntity(fromId);
  const to = await readEntity(toId);

  const fromObs = extractObservationsBlock(from.body);
  const toBody = insertObservations(to.body, fromObs);

  const aliases = unique([
    ...to.frontmatter.aliases,
    from.frontmatter.name,
    ...from.frontmatter.aliases,
  ]);

  const updated: EntityFrontmatter = {
    ...to.frontmatter,
    aliases,
    updated: today(),
  };
  await fs.writeFile(to.path, matter.stringify(toBody, updated));
  await fs.unlink(from.path);

  const wikilinks_rewritten = await rewriteWikilinks(fromId, toId);

  // Count observations roughly by counting H3 headings in the merged block.
  const observations_moved = (fromObs.match(/^### /gm) || []).length;
  return { observations_moved, wikilinks_rewritten };
}

function extractObservationsBlock(body: string): string {
  const idx = body.indexOf('## Observations');
  if (idx === -1) return '';
  const after = body.slice(idx + '## Observations'.length);
  // Stop at the next H2 heading if any.
  const next = after.search(/^##\s/m);
  return (next === -1 ? after : after.slice(0, next)).trim();
}

function insertObservations(body: string, block: string): string {
  if (!block.trim()) return body;
  const heading = '## Observations';
  const idx = body.indexOf(heading);
  if (idx === -1) {
    return body.trimEnd() + `\n\n${heading}\n\n${block}\n`;
  }
  const insertAt = idx + heading.length;
  return body.slice(0, insertAt) + '\n\n' + block + '\n' + body.slice(insertAt);
}

async function rewriteWikilinks(fromId: string, toId: string): Promise<number> {
  // Match [[fromId]] and [[fromId|alias]]; rewrite the slug part only.
  const re = new RegExp(
    `\\[\\[${escapeRegex(fromId)}(\\|[^\\]]*)?\\]\\]`,
    'g',
  );
  let count = 0;
  for (const file of await walkMarkdown(paths.vault)) {
    const content = await fs.readFile(file, 'utf8');
    if (!re.test(content)) continue;
    re.lastIndex = 0;
    const next = content.replace(re, (_, alias) => `[[${toId}${alias || ''}]]`);
    if (next !== content) {
      count += (content.match(re) || []).length;
      await fs.writeFile(file, next);
    }
  }
  return count;
}

async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      // raw/ is immutable; .memory/ is derived; .git/ is sync state.
      if (e.name === 'raw' || e.name === '.memory' || e.name === '.git') {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDir) await walk(full);
      else if (e.name.endsWith('.md')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(strings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of strings) {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function renderObservation(obs: Observation): string {
  const eventLine = obs.event_date ? `\n**event_date:** ${obs.event_date}` : '';
  return `### ${obs.date} — ${obs.headline}
> "${escapeQuote(obs.quote)}"
**source:** ${obs.source}
**date:** ${obs.date}${eventLine}
`;
}

// Parses observation blocks out of an entity body. Used by the timeline
// builder. Matches the exact shape emitted by renderObservation.
export interface ParsedObservation {
  date: string;
  headline: string;
  quote: string;
  source: string;
  event_date: string;
}

const OBS_BLOCK_RE = /^### (\d{4}-\d{2}-\d{2}) — (.+?)\n> "((?:[^"\\]|\\.)*?)"\n\*\*source:\*\* (.+?)\n\*\*date:\*\* (\d{4}-\d{2}-\d{2})(?:\n\*\*event_date:\*\* (\d{4}-\d{2}-\d{2}))?/gm;

export function parseObservations(body: string): ParsedObservation[] {
  const out: ParsedObservation[] = [];
  let m: RegExpExecArray | null;
  OBS_BLOCK_RE.lastIndex = 0;
  while ((m = OBS_BLOCK_RE.exec(body)) !== null) {
    out.push({
      date: m[1]!,
      headline: m[2]!.trim(),
      quote: m[3]!.replace(/\\"/g, '"'),
      source: m[4]!.trim(),
      event_date: m[6] ?? '',
    });
  }
  return out;
}

function escapeQuote(s: string): string {
  return s.replace(/"/g, '\\"');
}
