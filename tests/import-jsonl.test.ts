import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const execFileP = promisify(execFile);

let replSet: MongoMemoryReplSet;
let tmpVault: string;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.KIOKU_MONGO_URI = replSet.getUri();
  process.env.KIOKU_MONGO_DB = `kioku_import_test_${Date.now()}`;
  tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'kioku-import-test-'));
  await fs.mkdir(path.join(tmpVault, '.memory'), { recursive: true });
  process.env.KIOKU_VAULT = tmpVault;
});

beforeEach(async () => {
  const { getDb } = await import('../src/storage/mongo.ts');
  const db = await getDb();
  await Promise.all([
    db.collection('facts').deleteMany({}),
    db.collection('entities').deleteMany({}),
    db.collection('history').deleteMany({}),
  ]);
});

after(async () => {
  const { closeMongo } = await import('../src/storage/mongo.ts');
  await closeMongo();
  await replSet.stop();
  await fs.rm(tmpVault, { recursive: true, force: true });
});

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(path.join(tmpVault, '.memory', file), lines);
}

async function runImporter(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // The importer is a standalone node entry point. Invoke it via tsx so
  // the .ts source runs directly. Inheriting env so KIOKU_MONGO_URI etc.
  // propagate to the child.
  const scriptPath = path.resolve('scripts/import-jsonl.ts');
  return execFileP(
    process.execPath,
    ['--import', 'tsx', scriptPath, ...args],
    { env: process.env },
  );
}

test('importer reads facts.jsonl + entities.jsonl into Mongo', async () => {
  await writeJsonl('facts.jsonl', [
    {
      id: '11111111-1111-1111-1111-111111111111',
      text: 'User likes coffee',
      user_id: 'default',
      created_at: '2024-01-01T00:00:00Z',
      event_date: '2024-01-01',
      source_session: 'raw/s1',
      hash: 'h1',
      embedding: [1, 0, 0],
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      text: 'User has a cat named Mira',
      user_id: 'default',
      created_at: '2024-01-02T00:00:00Z',
      event_date: '2024-01-02',
      source_session: 'raw/s2',
      hash: 'h2',
      embedding: [0, 1, 0],
    },
  ]);
  await writeJsonl('entities.jsonl', [
    {
      id: '33333333-3333-3333-3333-333333333333',
      text: 'Mira',
      entity_type: 'PROPER',
      embedding: [1, 0, 0],
      linked_memory_ids: ['22222222-2222-2222-2222-222222222222'],
    },
  ]);

  const { stdout } = await runImporter([]);
  const summary = JSON.parse(stdout.split('\n').filter((l) => l.trim().startsWith('{')).join('\n'));
  assert.equal(summary.factsImported, 2);
  assert.equal(summary.entitiesImported, 1);
  assert.equal(summary.duplicatesSkipped, 0);
  assert.equal(summary.dryRun, false);

  const { getDb } = await import('../src/storage/mongo.ts');
  const db = await getDb();
  assert.equal(await db.collection('facts').countDocuments({}), 2);
  const ent = await db.collection('entities').findOne({ _id: '33333333-3333-3333-3333-333333333333' as never });
  assert.ok(ent);
  // Importer derives text_lower since it isn't in the legacy JSONL schema.
  assert.equal((ent as unknown as { text_lower: string }).text_lower, 'mira');
});

test('importer is idempotent: second run skips dupes', async () => {
  await writeJsonl('facts.jsonl', [
    {
      id: '11111111-1111-1111-1111-111111111111',
      text: 'X',
      user_id: 'default',
      created_at: '2024-01-01T00:00:00Z',
      event_date: '2024-01-01',
      source_session: 'raw/s1',
      hash: 'h1',
      embedding: [1, 0, 0],
    },
  ]);
  await writeJsonl('entities.jsonl', []);

  const first = JSON.parse(
    (await runImporter([])).stdout.split('\n').filter((l) => l.trim().startsWith('{')).join('\n'),
  );
  assert.equal(first.factsImported, 1);
  assert.equal(first.duplicatesSkipped, 0);

  const second = JSON.parse(
    (await runImporter([])).stdout.split('\n').filter((l) => l.trim().startsWith('{')).join('\n'),
  );
  assert.equal(second.factsImported, 0);
  assert.equal(second.duplicatesSkipped, 1);

  const { getDb } = await import('../src/storage/mongo.ts');
  const db = await getDb();
  assert.equal(await db.collection('facts').countDocuments({}), 1);
});

test('importer --dry-run reports counts without writing', async () => {
  await writeJsonl('facts.jsonl', [
    {
      id: '11111111-1111-1111-1111-111111111111',
      text: 'X',
      user_id: 'default',
      created_at: '2024-01-01T00:00:00Z',
      event_date: '2024-01-01',
      source_session: 'raw/s1',
      hash: 'h1',
      embedding: [1, 0, 0],
    },
  ]);
  await writeJsonl('entities.jsonl', []);

  const summary = JSON.parse(
    (await runImporter(['--dry-run'])).stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .join('\n'),
  );
  assert.equal(summary.factsImported, 1);
  assert.equal(summary.dryRun, true);

  const { getDb } = await import('../src/storage/mongo.ts');
  const db = await getDb();
  assert.equal(await db.collection('facts').countDocuments({}), 0);
});

test('importer does not emit history events for imported rows', async () => {
  await writeJsonl('facts.jsonl', [
    {
      id: '11111111-1111-1111-1111-111111111111',
      text: 'X',
      user_id: 'default',
      created_at: '2024-01-01T00:00:00Z',
      event_date: '2024-01-01',
      source_session: 'raw/s1',
      hash: 'h1',
      embedding: [1, 0, 0],
    },
  ]);
  await writeJsonl('entities.jsonl', []);

  await runImporter([]);

  const { readHistoryFor } = await import('../src/storage/history.ts');
  const events = await readHistoryFor('11111111-1111-1111-1111-111111111111');
  assert.equal(events.length, 0);
});
