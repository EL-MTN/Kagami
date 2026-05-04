import type { Collection, Db } from 'mongodb';
import { getDb } from './mongo.js';
import { logger } from '../logger.js';
import { embedQuestion } from '../llm.js';

// Idempotent index setup. Safe to call on every startup — Mongo's
// createIndex / createSearchIndex are no-ops when an equivalent index
// already exists (matched by name).
//
// Search + vector indexes are async on Atlas / atlas-local; this module
// polls $listSearchIndexes until each one reaches the READY state before
// returning, so callers can assume queries are safe immediately after.

const SEARCH_POLL_INTERVAL_MS = 500;
const SEARCH_POLL_TIMEOUT_MS = 60_000;

// Probe the embedding provider for its output dimension. The vector index
// must be created with a fixed numDimensions, and the provider is the
// authoritative source — that way an EMBEDDING_MODEL change is detected
// at startup (via the drift check below) instead of at the next write.
async function probeEmbeddingDim(): Promise<number> {
  const v = await embedQuestion('probe');
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error('embedding provider returned empty vector for probe');
  }
  return v.length;
}

interface SearchIndexSpec {
  name: string;
  type?: 'search' | 'vectorSearch';
  definition: Record<string, unknown>;
}

async function ensureBtreeIndexes(db: Db): Promise<void> {
  const facts: Collection = db.collection('facts');
  await facts.createIndex({ hash: 1 }, { name: 'facts_hash_unique', unique: true });
  await facts.createIndex(
    { user_id: 1, created_at: -1 },
    { name: 'facts_user_created' },
  );

  const entities: Collection = db.collection('entities');
  await entities.createIndex(
    { text_lower: 1 },
    { name: 'entities_text_lower_unique', unique: true },
  );

  const history: Collection = db.collection('history');
  await history.createIndex(
    { memory_id: 1, created_at: -1 },
    { name: 'history_memory_created' },
  );
}

interface ExistingSearchIndex {
  name: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: {
    fields?: Array<{
      type?: string;
      path?: string;
      numDimensions?: number;
      similarity?: string;
    }>;
  };
}

async function listSearchIndexes(coll: Collection): Promise<ExistingSearchIndex[]> {
  // $listSearchIndexes requires Atlas / atlas-local. On vanilla mongo
  // (e.g. mongodb-memory-server) this throws with code 40324 or similar.
  const cursor = coll.aggregate([{ $listSearchIndexes: {} }]);
  return (await cursor.toArray()) as ExistingSearchIndex[];
}

function existingVectorDim(idx: ExistingSearchIndex): number | undefined {
  const f = idx.latestDefinition?.fields?.find((x) => x.type === 'vector');
  return f?.numDimensions;
}

async function ensureSearchIndex(
  coll: Collection,
  spec: SearchIndexSpec,
  existing: ExistingSearchIndex[],
  expectedVectorDim?: number,
): Promise<void> {
  const match = existing.find((i) => i.name === spec.name);
  if (match) {
    if (expectedVectorDim !== undefined) {
      const actual = existingVectorDim(match);
      if (actual !== undefined && actual !== expectedVectorDim) {
        throw new Error(
          `vector index ${spec.name} on ${coll.collectionName} was built for ` +
            `numDimensions=${actual} but the embedding provider now returns ` +
            `${expectedVectorDim}. Did EMBEDDING_MODEL change? Drop the index ` +
            `(db.${coll.collectionName}.dropSearchIndex("${spec.name}")) and restart.`,
        );
      }
    }
  } else {
    // The driver exposes createSearchIndex; the type field defaults to
    // 'search' so we only pass it when 'vectorSearch'.
    await coll.createSearchIndex({
      name: spec.name,
      ...(spec.type ? { type: spec.type } : {}),
      definition: spec.definition,
    });
  }
  await waitForSearchIndexReady(coll, spec.name);
}

async function waitForSearchIndexReady(coll: Collection, name: string): Promise<void> {
  const deadline = Date.now() + SEARCH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const indexes = await listSearchIndexes(coll);
    const idx = indexes.find((i) => i.name === name);
    if (idx && (idx.status === 'READY' || idx.queryable === true)) return;
    await new Promise((r) => setTimeout(r, SEARCH_POLL_INTERVAL_MS));
  }
  throw new Error(`search index ${name} did not reach READY within ${SEARCH_POLL_TIMEOUT_MS}ms`);
}

async function ensureSearchAndVectorIndexes(db: Db): Promise<void> {
  const facts = db.collection('facts');
  const entities = db.collection('entities');

  // Probe Atlas Search support BEFORE hitting the embedding provider — on
  // vanilla mongo this throws and the outer catch swallows it (when
  // allowMissingSearch is set), so we never make a needless embed call.
  const existingFacts = await listSearchIndexes(facts);
  const existingEntities = await listSearchIndexes(entities);

  const dim = await probeEmbeddingDim();

  // facts_vec: cosine vector search over fact embeddings.
  await ensureSearchIndex(
    facts,
    {
      name: 'facts_vec',
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions: dim,
            similarity: 'cosine',
          },
        ],
      },
    },
    existingFacts,
    dim,
  );

  // facts_text: BM25 over the pre-lemmatized text. Phase 4 picks the
  // analyzer; for now use lucene.keyword since lemmatizeForBm25 already
  // tokenizes and we don't want re-tokenization to fight it.
  await ensureSearchIndex(
    facts,
    {
      name: 'facts_text',
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            text_lemmatized: {
              type: 'string',
              analyzer: 'lucene.keyword',
            },
          },
        },
      },
    },
    existingFacts,
  );

  // entities_vec: cosine vector search over entity embeddings.
  await ensureSearchIndex(
    entities,
    {
      name: 'entities_vec',
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions: dim,
            similarity: 'cosine',
          },
        ],
      },
    },
    existingEntities,
    dim,
  );
}

function isSearchUnsupportedError(err: unknown): boolean {
  // mongodb-memory-server / vanilla mongo rejects $listSearchIndexes and
  // createSearchIndex with codes like 40324 ('Unrecognized pipeline stage')
  // or 115 ('CommandNotSupported'). We don't want these to fail tests that
  // only care about btree indexes.
  const e = err as { code?: number; codeName?: string; message?: string };
  if (e?.code === 40324 || e?.code === 115 || e?.code === 59) return true;
  const msg = e?.message ?? '';
  return (
    msg.includes('$listSearchIndexes') ||
    msg.includes('Atlas') ||
    msg.includes('SearchNotEnabled') ||
    msg.includes('search index')
  );
}

export interface EnsureIndexesOptions {
  // When true, skip $search/$vectorSearch index creation if the server
  // doesn't support them (vanilla mongo / mongodb-memory-server). Default
  // false — production must have atlas-local.
  allowMissingSearch?: boolean;
}

export async function ensureIndexes(opts: EnsureIndexesOptions = {}): Promise<void> {
  const db = await getDb();
  await ensureBtreeIndexes(db);

  try {
    await ensureSearchAndVectorIndexes(db);
  } catch (err) {
    if (opts.allowMissingSearch && isSearchUnsupportedError(err)) {
      logger.warn(
        { err: (err as Error).message },
        'search/vector indexes skipped — server lacks Atlas Search support',
      );
      return;
    }
    throw err;
  }
}
