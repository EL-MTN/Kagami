import fs from 'node:fs/promises';
import matter from 'gray-matter';
import {
  TranscriptFrontmatter,
  type Transcript,
  type Turn,
} from '../types.js';

const TURN_HEADING = /^##\s+(t-\d+)\s+(\S+)\s*$/;

export async function readTranscript(file: string): Promise<Transcript> {
  const raw = await fs.readFile(file, 'utf8');
  return parseTranscript(raw);
}

export function parseTranscript(raw: string): Transcript {
  const { data, content } = matter(raw);
  const frontmatter = TranscriptFrontmatter.parse(data);
  const turns = parseTurns(content);
  return { frontmatter, turns };
}

function parseTurns(body: string): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const line of body.split('\n')) {
    const m = line.match(TURN_HEADING);
    if (m) {
      if (current) turns.push(finalize(current));
      current = { id: m[1]!, role: m[2]!, text: '' };
    } else if (current) {
      current.text += line + '\n';
    }
  }
  if (current) turns.push(finalize(current));
  return turns;
}

function finalize(t: Turn): Turn {
  return { ...t, text: t.text.trim() };
}
