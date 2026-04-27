import fs from 'node:fs/promises';
import path from 'node:path';
import { readTranscript } from './transcript.js';
import { callJsonText } from './llm.js';
import {
  appendObservation,
  createEntity,
  findByNameOrAlias,
  unionAliases,
} from './entity_io.js';
import {
  ExtractionResult,
  type Candidate,
  type LogEntry,
  type Observation,
  type Transcript,
} from './types.js';
import { entityPath, paths, slug, transcriptWikilink } from './paths.js';
import { rebuildIndex } from './index_md.js';

export interface IngestResult {
  candidates: number;
  appended: number;
  created: number;
  duplicated: number;
}

const EMPTY: IngestResult = {
  candidates: 0,
  appended: 0,
  created: 0,
  duplicated: 0,
};

export async function consolidate(transcriptFile: string): Promise<IngestResult> {
  const transcript = await readTranscript(transcriptFile);
  const candidates = await extract(transcript);
  if (!candidates) return { ...EMPTY };
  return applyCandidates(candidates, transcript.frontmatter.id);
}

// Pure-deterministic post-extraction step. Tested directly without an LLM.
export async function applyCandidates(
  candidates: Candidate[],
  transcriptId: string,
): Promise<IngestResult> {
  const result: IngestResult = { ...EMPTY, candidates: candidates.length };

  for (const cand of candidates) {
    const obs = candidateToObservation(cand, transcriptId);
    const targets = await findByNameOrAlias(cand.entity_name);

    if (targets.length === 0) {
      const id = await uniqueSlug(cand.entity_name);
      const aliases = unique([cand.entity_name, ...cand.aliases_seen]);
      await createEntity({
        id,
        name: cand.entity_name,
        aliases,
        type: cand.type,
        anchor: '',
        updated: cand.date,
      });
      await appendObservation(id, obs);
      await writeLog({
        ts: new Date().toISOString(),
        entity_id: id,
        observation: obs,
        source_turn: cand.turn_id,
        candidate_subject: cand.entity_name,
        decision: 'created',
      });
      result.created += 1;
      result.appended += 1;
      continue;
    }

    if (targets.length > 1) result.duplicated += 1;
    for (const target of targets) {
      await unionAliases(target.id, cand.aliases_seen);
      await appendObservation(target.id, obs);
      await writeLog({
        ts: new Date().toISOString(),
        entity_id: target.id,
        observation: obs,
        source_turn: cand.turn_id,
        candidate_subject: cand.entity_name,
        decision: targets.length === 1 ? 'matched' : 'duplicated',
      });
      result.appended += 1;
    }
  }

  await rebuildIndex();
  return result;
}

async function extract(transcript: Transcript): Promise<Candidate[] | null> {
  const promptFile = path.join(paths.prompts, 'extraction.md');
  const promptText = await fs.readFile(promptFile, 'utf8');
  const { system, userTemplate } = parsePrompt(promptText);

  const turns = transcript.turns
    .map((t) => `## ${t.id} ${t.role}\n${t.text}`)
    .join('\n\n');
  const date = transcript.frontmatter.started_at.slice(0, 10);

  const userPrompt = userTemplate
    .replace('{{date}}', date)
    .replace('{{transcript_id}}', transcript.frontmatter.id)
    .replace('{{turns}}', turns);

  const result = await callJsonText({
    stage: 'extraction',
    schema: ExtractionResult,
    systemPrompt: system,
    userPrompt,
  });
  return result?.candidates ?? null;
}

export function parsePrompt(raw: string): {
  system: string;
  userTemplate: string;
} {
  const sys = raw.match(/^##\s+System\s*\n([\s\S]*?)(?=^##\s+User\b)/m);
  const usr = raw.match(/^##\s+User[^\n]*\n([\s\S]*)$/m);
  if (!sys || !usr) {
    throw new Error(
      'Prompt file must contain "## System" and "## User" sections',
    );
  }
  return { system: sys[1]!.trim(), userTemplate: usr[1]!.trim() };
}

function candidateToObservation(c: Candidate, transcriptId: string): Observation {
  return {
    date: c.date,
    headline: c.headline,
    quote: c.quote,
    source: transcriptWikilink(transcriptId, c.turn_id),
  };
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slug(name) || 'entity';
  let candidate = base;
  let n = 2;
  while (await fileExists(entityPath(candidate))) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeLog(entry: LogEntry): Promise<void> {
  await fs.mkdir(paths.internal, { recursive: true });
  await fs.appendFile(paths.log, JSON.stringify(entry) + '\n');
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
