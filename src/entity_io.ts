import fs from 'node:fs/promises';
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

function renderObservation(obs: Observation): string {
  return `### ${obs.date} — ${obs.headline}
> "${escapeQuote(obs.quote)}"
**source:** ${obs.source}
**date:** ${obs.date}
`;
}

function escapeQuote(s: string): string {
  return s.replace(/"/g, '\\"');
}
