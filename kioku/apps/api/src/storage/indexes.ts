import type { Collection, Db } from "mongodb";
import { getDb } from "./mongo.js";
import { logger } from "../logger.js";
import { embedQuestion } from "../llm.js";

// Idempotent index setup. Safe to call on every startup — Mongo's
// createIndex / createSearchIndex are no-ops when an equivalent index
// already exists (matched by name).
//
// Search + vector indexes are async on Atlas / atlas-local; this module
// polls $listSearchIndexes until each one reaches the READY state before
// returning, so callers can assume queries are safe immediately after.

const SEARCH_POLL_INTERVAL_MS = 500;
// Atlas-local's mongot is slower than production Atlas at building search
// indexes — rapid sequential bench runs (100 fresh DBs each needing fresh
// vector + search indexes) push past 60s on a meaningful fraction of items.
// 180s is the empirically-found ceiling that holds across the bench.
const SEARCH_POLL_TIMEOUT_MS = 180_000;

// Probe the embedding provider for its output dimension. The vector index
// must be created with a fixed numDimensions, and the provider is the
// authoritative source — that way an EMBEDDING_MODEL change is detected
// at startup (via the drift check below) instead of at the next write.
async function probeEmbeddingDim(): Promise<number> {
  const v = await embedQuestion("probe");
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("embedding provider returned empty vector for probe");
  }
  return v.length;
}

function describeEmbeddingEndpoint(): string {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "lmstudio").toLowerCase();
  const defaultURL =
    provider === "openai" ? "https://api.openai.com/v1" : "http://localhost:1234/v1";
  const url = process.env.EMBEDDING_URL ?? defaultURL;
  const model = process.env.EMBEDDING_MODEL ?? "<default>";
  return `EMBEDDING_PROVIDER=${provider}, EMBEDDING_URL=${url}, EMBEDDING_MODEL=${model}`;
}

interface SearchIndexSpec {
  name: string;
  type?: "search" | "vectorSearch";
  definition: Record<string, unknown>;
}

async function ensureBtreeIndexes(db: Db): Promise<void> {
  const facts: Collection = db.collection("facts");

  // Hash-dedup index. Scoped by (user_id, run_id, agent_id) so identical
  // text under different scopes does not collide. The legacy index was
  // {hash:1} unscoped — drop it on first startup after the scope upgrade
  // and replace with the scoped version. Mongo treats a missing field as
  // null, so existing rows with no run_id/agent_id still satisfy uniqueness
  // within the (user_id='default', null, null) scope they were written in.
  //
  // facts.indexes() throws NamespaceNotFound when the collection has
  // never been written to — fresh deployments and fresh test DBs hit
  // this. In that case there's no legacy state to migrate from.
  let existingIndexes: Array<{ name?: string; key?: Record<string, unknown> }> = [];
  try {
    existingIndexes = await facts.indexes();
  } catch (err) {
    if ((err as { code?: number }).code !== 26) throw err;
  }
  // Drop the legacy hash unique index if present. Dedup moved from
  // storage-layer (md5 unique constraint) to ingest-layer (cosine in
  // append.ts and consolidate.ts). The hash field is no longer written
  // to new facts.
  const hashIdx = existingIndexes.find((i) => i.name === "facts_hash_unique");
  if (hashIdx) {
    await facts.dropIndex("facts_hash_unique");
  }

  // Same scope-prefix story for the read-side compound index. Pre-scope
  // shape was {user_id:1, created_at:-1}; the new shape covers scope
  // filters too. Same drop-and-recreate dance.
  const legacyUserCreated = existingIndexes.find(
    (i) =>
      i.name === "facts_user_created" &&
      i.key &&
      Object.keys(i.key).length === 2 &&
      "user_id" in i.key &&
      "created_at" in i.key,
  );
  if (legacyUserCreated) {
    await facts.dropIndex("facts_user_created");
  }
  await facts.createIndex(
    { user_id: 1, run_id: 1, agent_id: 1, created_at: -1 },
    { name: "facts_user_created" },
  );

  const entities: Collection = db.collection("entities");
  await entities.createIndex(
    { text_lower: 1 },
    { name: "entities_text_lower_unique", unique: true },
  );

  const history: Collection = db.collection("history");
  await history.createIndex({ memory_id: 1, created_at: -1 }, { name: "history_memory_created" });
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
    mappings?: {
      fields?: Record<string, { type?: string; analyzer?: string }>;
    };
  };
}

async function listSearchIndexes(coll: Collection): Promise<ExistingSearchIndex[]> {
  // $listSearchIndexes requires Atlas / atlas-local. On vanilla mongo
  // (e.g. mongodb-memory-server) this throws with code 40324 or similar.
  const cursor = coll.aggregate([{ $listSearchIndexes: {} }]);
  return (await cursor.toArray()) as ExistingSearchIndex[];
}

function existingVectorDim(idx: ExistingSearchIndex): number | undefined {
  const f = idx.latestDefinition?.fields?.find((x) => x.type === "vector");
  return f?.numDimensions;
}

function existingFieldAnalyzer(idx: ExistingSearchIndex, fieldPath: string): string | undefined {
  return idx.latestDefinition?.mappings?.fields?.[fieldPath]?.analyzer;
}

function existingFilterFieldPaths(idx: ExistingSearchIndex): Set<string> {
  const out = new Set<string>();
  for (const f of idx.latestDefinition?.fields ?? []) {
    if (f.type === "filter" && f.path) out.add(f.path);
  }
  return out;
}

function expectedFilterFieldPaths(spec: SearchIndexSpec): string[] {
  const fields =
    (spec.definition.fields as Array<{ type?: string; path?: string }> | undefined) ?? [];
  return fields.filter((f) => f.type === "filter" && f.path).map((f) => f.path!);
}

function expectedMappedFieldPaths(spec: SearchIndexSpec): string[] {
  const m = spec.definition.mappings as { fields?: Record<string, unknown> } | undefined;
  return m?.fields ? Object.keys(m.fields) : [];
}

function existingMappedFieldPaths(idx: ExistingSearchIndex): Set<string> {
  return new Set(Object.keys(idx.latestDefinition?.mappings?.fields ?? {}));
}

async function ensureSearchIndex(
  coll: Collection,
  spec: SearchIndexSpec,
  existing: ExistingSearchIndex[],
  expectedVectorDim?: number,
  expectedAnalyzer?: { path: string; analyzer: string },
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
    if (expectedAnalyzer) {
      const actual = existingFieldAnalyzer(match, expectedAnalyzer.path);
      if (actual !== undefined && actual !== expectedAnalyzer.analyzer) {
        throw new Error(
          `search index ${spec.name} on ${coll.collectionName} uses analyzer ` +
            `"${actual}" but the spec now expects "${expectedAnalyzer.analyzer}". ` +
            `Drop the index (db.${coll.collectionName}.dropSearchIndex("${spec.name}")) and restart.`,
        );
      }
    }
    // Schema drift detection — additive expansions only. If the spec adds
    // filter fields (vector index) or mapped fields (search index) that
    // the live index doesn't have yet, reconcile.
    //
    // Atlas updateSearchIndex works for search-type indexes but rejects
    // vectorSearch updates ("mappings is required" against a definition
    // that legitimately has no mappings). For vectorSearch we drop+recreate
    // — re-indexing rebuilds HNSW from existing docs, no data loss.
    const wantFilters = expectedFilterFieldPaths(spec);
    const haveFilters = existingFilterFieldPaths(match);
    const missingFilters = wantFilters.filter((p) => !haveFilters.has(p));
    const wantMapped = expectedMappedFieldPaths(spec);
    const haveMapped = existingMappedFieldPaths(match);
    const missingMapped = wantMapped.filter((p) => !haveMapped.has(p));
    if (missingFilters.length > 0 || missingMapped.length > 0) {
      if (spec.type === "vectorSearch") {
        logger.info(
          { index: spec.name, missingFilters },
          "recreating vectorSearch index (additive schema drift; updateSearchIndex not supported for vectorSearch)",
        );
        await coll.dropSearchIndex(spec.name);
        await coll.createSearchIndex({
          name: spec.name,
          type: "vectorSearch",
          definition: spec.definition,
        });
      } else {
        logger.info(
          { index: spec.name, missingMapped },
          "updating search index in place (additive schema drift)",
        );
        await coll.updateSearchIndex(spec.name, spec.definition);
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
    if (idx && (idx.status === "READY" || idx.queryable === true)) return;
    await new Promise((r) => setTimeout(r, SEARCH_POLL_INTERVAL_MS));
  }
  throw new Error(`search index ${name} did not reach READY within ${SEARCH_POLL_TIMEOUT_MS}ms`);
}

async function ensureSearchAndVectorIndexes(db: Db): Promise<void> {
  const facts = db.collection("facts");
  const entities = db.collection("entities");

  // Probe Atlas Search support BEFORE hitting the embedding provider — on
  // vanilla mongo this throws and the outer catch swallows it (when
  // allowMissingSearch is set), so we never make a needless embed call.
  const existingFacts = await listSearchIndexes(facts);
  const existingEntities = await listSearchIndexes(entities);

  let dim: number;
  try {
    dim = await probeEmbeddingDim();
  } catch (err) {
    throw new Error(
      `embedding provider probe failed (${describeEmbeddingEndpoint()}). ` +
        `Is the embedding endpoint running and serving the configured model? — ` +
        (err as Error).message,
      { cause: err },
    );
  }

  // facts_vec: cosine vector search over fact embeddings. Filter fields
  // (user_id, run_id, agent_id, category) are declared so $vectorSearch's
  // `filter` operator can push them down. Metadata stays dynamic — we
  // can't pre-declare arbitrary keys, so metadata filters happen via a
  // post-vector-search $match stage in the retrieval pipeline.
  await ensureSearchIndex(
    facts,
    {
      name: "facts_vec",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: dim,
            similarity: "cosine",
          },
          { type: "filter", path: "user_id" },
          { type: "filter", path: "run_id" },
          { type: "filter", path: "agent_id" },
          { type: "filter", path: "category" },
        ],
      },
    },
    existingFacts,
    dim,
  );

  // facts_text: BM25 over the pre-lemmatized text. lucene.whitespace
  // tokenizes on whitespace only — no re-stemming, no re-lowercasing —
  // because lemmatizeForBm25 already did all of that at write time.
  // Same analyzer applies to the query string at search time, so query
  // tokens line up exactly with indexed tokens.
  //
  // Scope + category fields are mapped as `token` for exact-match
  // filtering via $search.compound.filter. Metadata is dynamic (post-$match).
  await ensureSearchIndex(
    facts,
    {
      name: "facts_text",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            text_lemmatized: {
              type: "string",
              analyzer: "lucene.whitespace",
            },
            user_id: { type: "token" },
            run_id: { type: "token" },
            agent_id: { type: "token" },
            category: { type: "token" },
          },
        },
      },
    },
    existingFacts,
    undefined,
    { path: "text_lemmatized", analyzer: "lucene.whitespace" },
  );

  // entities_vec: cosine vector search over entity embeddings.
  await ensureSearchIndex(
    entities,
    {
      name: "entities_vec",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: dim,
            similarity: "cosine",
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
  const msg = e?.message ?? "";
  return (
    msg.includes("$listSearchIndexes") ||
    msg.includes("Atlas") ||
    msg.includes("SearchNotEnabled") ||
    msg.includes("search index")
  );
}

export interface EnsureIndexesOptions {
  // When true, skip $search/$vectorSearch index creation if the server
  // doesn't support them (vanilla mongo / mongodb-memory-server). Default
  // false — production must have atlas-local.
  allowMissingSearch?: boolean;
}

export async function ensureIndexes(opts: EnsureIndexesOptions = {}): Promise<void> {
  let db: Db;
  try {
    db = await getDb();
  } catch (err) {
    throw new Error(
      `MongoDB connection failed (KIOKU_MONGO_URI=${process.env.KIOKU_MONGO_URI ?? "<default>"}). ` +
        `Is the atlas-local container running? — ` +
        (err as Error).message,
      { cause: err },
    );
  }

  await ensureBtreeIndexes(db);

  try {
    await ensureSearchAndVectorIndexes(db);
  } catch (err) {
    if (opts.allowMissingSearch && isSearchUnsupportedError(err)) {
      logger.warn(
        { err: (err as Error).message },
        "search/vector indexes skipped — server lacks Atlas Search support",
      );
      return;
    }
    throw err;
  }
}
