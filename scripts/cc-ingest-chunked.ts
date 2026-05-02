// Convert a Claude Code session into N-turn chunks and run consolidate on each.
// Mem0-style md5 dedup at ingest collapses byte-identical text duplicates
// across chunks automatically.
//
// Usage:
//   tsx scripts/cc-ingest-chunked.ts <session.jsonl> [--chunk-size N] [--char-cap N]

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/paths.ts';
import { consolidate } from '../src/ingest.ts';

interface Args {
  in: string;
  chunkSize: number;
  charCap: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const inPath = a[0];
  if (!inPath) {
    console.error(
      'usage: tsx scripts/cc-ingest-chunked.ts <session.jsonl> [--chunk-size N] [--char-cap N]',
    );
    process.exit(1);
  }
  const cs = a.indexOf('--chunk-size');
  const cc = a.indexOf('--char-cap');
  return {
    in: inPath,
    chunkSize: cs >= 0 ? Number(a[cs + 1]) : 25,
    charCap: cc >= 0 ? Number(a[cc + 1]) : 1500,
  };
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object' && (b as { type: string }).type === 'text') {
        return (b as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function isSystemNoise(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('Caveat:') ||
    trimmed.startsWith('<local-command-stdout>')
  );
}

function loadTurns(file: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let evt: { type?: string; message?: { content?: unknown }; timestamp?: string };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== 'user' && evt.type !== 'assistant') continue;
    const text = extractText(evt.message?.content).trim();
    if (!text || isSystemNoise(text)) continue;
    turns.push({ role: evt.type, text, timestamp: evt.timestamp ?? '' });
  }
  return turns;
}

function clip(s: string, cap: number): string {
  return s.length <= cap ? s : s.slice(0, cap).trimEnd() + '\n\n[…truncated…]';
}

function render(turns: Turn[], id: string, startedAt: string, charCap: number): string {
  const lines = ['---', `id: ${id}`, `started_at: ${startedAt}`, '---', ''];
  turns.forEach((t, i) => {
    const seq = String(i + 1).padStart(4, '0');
    lines.push(`## t-${seq} ${t.role}`);
    lines.push(clip(t.text, charCap));
    lines.push('');
  });
  return lines.join('\n');
}

const args = parseArgs();
const all = loadTurns(args.in);
const sessionId = path
  .basename(args.in, '.jsonl')
  .replace(/[^a-zA-Z0-9-]/g, '-')
  .slice(0, 32);

await fs.promises.mkdir(paths.raw, { recursive: true });

const totals = { candidates: 0, appended: 0, created: 0, duplicated: 0 };
const chunkCount = Math.ceil(all.length / args.chunkSize);

for (let i = 0; i < all.length; i += args.chunkSize) {
  const chunkIdx = Math.floor(i / args.chunkSize) + 1;
  const chunk = all.slice(i, i + args.chunkSize);
  const id = `${sessionId}-c${String(chunkIdx).padStart(2, '0')}`;
  const file = path.join(paths.raw, `${id}.md`);
  const startedAt = chunk[0]?.timestamp || new Date().toISOString();
  await fs.promises.writeFile(
    file,
    render(chunk, id, startedAt, args.charCap),
  );
  console.log(`[${chunkIdx}/${chunkCount}] consolidating ${chunk.length} turns...`);
  const t0 = Date.now();
  const r = await consolidate(file);
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${ms}s, ${JSON.stringify(r)}`);
  totals.candidates += r.candidates;
  totals.appended += r.appended;
  totals.created += r.created;
  totals.duplicated += r.duplicated;
}

console.log('TOTAL:', JSON.stringify(totals));
