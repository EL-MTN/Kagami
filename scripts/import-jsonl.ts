// One-shot importer for users migrating an existing JSONL vault into
// MongoDB. Reads $KIOKU_VAULT/.memory/{facts,entities}.jsonl and writes
// the rows directly to the kioku.facts / kioku.entities collections.
//
// Idempotent: the unique indexes on facts.hash and entities.text_lower
// drop duplicate rows on re-runs.
//
// Imports do NOT emit history events. The audit log is for *new*
// mutations; the imported facts already happened, with their original
// created_at preserved on the row.
//
// Usage:
//   tsx scripts/import-jsonl.ts [--dry-run] [--batch-size 500]

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Collection } from 'mongodb';
import { paths } from '../src/paths.ts';
import { getDb, closeMongo } from '../src/storage/mongo.ts';

interface Args {
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const dryRun = a.includes('--dry-run');
  const bsIdx = a.indexOf('--batch-size');
  let batchSize = 500;
  if (bsIdx >= 0) {
    const parsed = Number.parseInt(a[bsIdx + 1] ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error('--batch-size must be a positive integer');
      process.exit(1);
    }
    batchSize = parsed;
  }
  return { dryRun, batchSize };
}

interface FactJsonl {
  id: string;
  text: string;
  text_lemmatized?: string;
  user_id: string;
  created_at: string;
  event_date: string;
  source_session: string;
  hash: string;
  embedding: number[];
}

interface EntityJsonl {
  id: string;
  text: string;
  entity_type: string;
  embedding: number[];
  linked_memory_ids: string[];
}

async function* readJsonlLines<T>(p: string): AsyncGenerator<T> {
  if (!fs.existsSync(p)) return;
  const stream = fs.createReadStream(p, 'utf8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    yield JSON.parse(line) as T;
  }
}

interface FlushResult {
  inserted: number;
  dupes: number;
}

async function insertBatch(
  col: Collection,
  docs: object[],
): Promise<FlushResult> {
  if (docs.length === 0) return { inserted: 0, dupes: 0 };
  try {
    const res = await col.insertMany(docs as never, { ordered: false });
    return { inserted: res.insertedCount, dupes: 0 };
  } catch (err) {
    const e = err as {
      code?: number;
      writeErrors?: Array<{ code?: number }>;
      result?: { insertedCount?: number };
      insertedCount?: number;
    };
    const errs = Array.isArray(e.writeErrors) ? e.writeErrors : [];
    const allDupes =
      e.code === 11000 || (errs.length > 0 && errs.every((w) => w.code === 11000));
    if (!allDupes) throw err;
    const inserted = e.insertedCount ?? e.result?.insertedCount ?? 0;
    return { inserted, dupes: errs.length };
  }
}

// Both collections need their unique indexes for dedup to work. ensureIndexes()
// at server boot creates these too; we run them here so the importer is
// runnable without a live atlas-local + embedding endpoint.
async function ensureUniqueIndexes(): Promise<void> {
  const db = await getDb();
  await db
    .collection('facts')
    .createIndex({ hash: 1 }, { name: 'facts_hash_unique', unique: true });
  await db
    .collection('entities')
    .createIndex(
      { text_lower: 1 },
      { name: 'entities_text_lower_unique', unique: true },
    );
}

async function importFacts(opts: Args): Promise<FlushResult> {
  const factsPath = path.join(paths.vault, '.memory', 'facts.jsonl');
  if (!fs.existsSync(factsPath)) {
    console.log(`[import] no facts.jsonl at ${factsPath}, skipping`);
    return { inserted: 0, dupes: 0 };
  }

  const db = await getDb();
  const col = db.collection('facts');
  let totals: FlushResult = { inserted: 0, dupes: 0 };
  let batch: object[] = [];

  for await (const fact of readJsonlLines<FactJsonl>(factsPath)) {
    const { id, ...rest } = fact;
    batch.push({ _id: id, ...rest });
    if (batch.length >= opts.batchSize) {
      if (opts.dryRun) {
        totals.inserted += batch.length;
      } else {
        const r = await insertBatch(col, batch);
        totals.inserted += r.inserted;
        totals.dupes += r.dupes;
      }
      batch = [];
    }
  }
  if (batch.length > 0) {
    if (opts.dryRun) {
      totals.inserted += batch.length;
    } else {
      const r = await insertBatch(col, batch);
      totals.inserted += r.inserted;
      totals.dupes += r.dupes;
    }
  }
  return totals;
}

async function importEntities(opts: Args): Promise<FlushResult> {
  const entitiesPath = path.join(paths.vault, '.memory', 'entities.jsonl');
  if (!fs.existsSync(entitiesPath)) {
    console.log(`[import] no entities.jsonl at ${entitiesPath}, skipping`);
    return { inserted: 0, dupes: 0 };
  }

  const db = await getDb();
  const col = db.collection('entities');
  let totals: FlushResult = { inserted: 0, dupes: 0 };
  let batch: object[] = [];

  for await (const ent of readJsonlLines<EntityJsonl>(entitiesPath)) {
    const { id, text, ...rest } = ent;
    // text_lower wasn't in the JSONL schema — Phase 3 added it as the
    // case-insensitive upsert key. Compute on the fly from the display text.
    batch.push({
      _id: id,
      text,
      text_lower: text.trim().toLowerCase(),
      ...rest,
    });
    if (batch.length >= opts.batchSize) {
      if (opts.dryRun) {
        totals.inserted += batch.length;
      } else {
        const r = await insertBatch(col, batch);
        totals.inserted += r.inserted;
        totals.dupes += r.dupes;
      }
      batch = [];
    }
  }
  if (batch.length > 0) {
    if (opts.dryRun) {
      totals.inserted += batch.length;
    } else {
      const r = await insertBatch(col, batch);
      totals.inserted += r.inserted;
      totals.dupes += r.dupes;
    }
  }
  return totals;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log(
    `[import] vault=${paths.vault} dryRun=${opts.dryRun} batchSize=${opts.batchSize}`,
  );

  if (!opts.dryRun) {
    await ensureUniqueIndexes();
  }

  const factsResult = await importFacts(opts);
  const entitiesResult = await importEntities(opts);

  const summary = {
    factsImported: factsResult.inserted,
    entitiesImported: entitiesResult.inserted,
    duplicatesSkipped: factsResult.dupes + entitiesResult.dupes,
    dryRun: opts.dryRun,
  };
  console.log(JSON.stringify(summary));

  await closeMongo();
}

main().catch((err) => {
  console.error('[import] fatal:', (err as Error).message);
  void closeMongo().finally(() => process.exit(1));
});
