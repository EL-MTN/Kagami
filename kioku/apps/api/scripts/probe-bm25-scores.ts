// One-shot diagnostic: ingest a small slice of LongMemEval items, then
// for each item embed+lemmatize the question and capture the raw
// $search BM25 scores Atlas returns. Output: per-item samples + a
// bucketed distribution summary so getBm25Params can be re-tuned.
//
// Mode is split into orchestrator (default) + per-item worker, switched
// by KIOKU_PROBE_WORKER=1 in the env. Same self-spawning pattern as the
// bench, so we get vault + Mongo-DB isolation per item.
//
// Usage:
//   tsx scripts/probe-bm25-scores.ts [--limit 20] [--data <path>]

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { logger } from "../src/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const benchRoot = path.join(projectRoot, "bench/longmemeval");

interface LMESession {
  role: "user" | "assistant";
  content: string;
}
interface LMEItem {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_sessions: LMESession[][];
  haystack_session_ids: string[];
  haystack_dates: string[];
}

interface ProbeSample {
  question_id: string;
  question: string;
  query_term_count: number;
  fact_count: number;
  // Raw $search scores for the top-N candidates, descending.
  scores: number[];
}

function dbNameFor(qid: string): string {
  const safe = qid.replace(/[^A-Za-z0-9_-]/g, "_");
  return `kioku_probe_${safe}`;
}

// ------------------------------------------------------------ Worker

async function runWorker(): Promise<void> {
  const itemPath = process.env.KIOKU_PROBE_ITEM!;
  const outPath = process.env.KIOKU_PROBE_OUT!;
  const item = JSON.parse(await fs.readFile(itemPath, "utf8")) as LMEItem;

  const { ensureIndexes } = await import("../src/storage/indexes.js");
  const { getDb, closeMongo } = await import("../src/storage/mongo.js");
  const { consolidate } = await import("../src/ingest/consolidate.js");
  const { parseTranscript } = await import("../src/ingest/transcript.js");
  const { upsertTranscript } = await import("../src/storage/transcripts.js");
  const { embedQuestion } = await import("../src/llm.js");
  const { lemmatizeForBm25 } = await import("../src/retrieval/text.js");

  await ensureIndexes();

  const factCountBefore = await (await getDb()).collection("facts").countDocuments({});
  if (factCountBefore === 0) {
    for (let i = 0; i < item.haystack_sessions.length; i++) {
      const sid = item.haystack_session_ids[i]!;
      const date = item.haystack_dates[i]!;
      const turns = item.haystack_sessions[i]!;
      const transcript = parseTranscript(formatTranscript(sid, date, turns));
      await upsertTranscript({ transcript });
      process.stderr.write(`[probe ${item.question_id}] ingest ${sid} (${turns.length} turns)\n`);
      await consolidate(transcript);
    }
  } else {
    process.stderr.write(`[probe ${item.question_id}] ingest skipped\n`);
  }

  const queryLemmatized = lemmatizeForBm25(item.question);
  const termCount = queryLemmatized.split(/\s+/).filter(Boolean).length;

  // Embed isn't needed for $search but we want the call-stack identical
  // to the live retrieval path so any tokenizer warm-up etc. matches.
  await embedQuestion(item.question);

  const db = await getDb();
  const factsCol = db.collection("facts");
  const factCount = await factsCol.countDocuments({});

  let scores: number[] = [];
  if (queryLemmatized.length > 0 && factCount > 0) {
    // Mirror the production retrieval $search exactly — same index, same
    // analyzer (lucene.whitespace), same path. No app-side rewriting.
    const hits = await factsCol
      .aggregate<{ _id: string; bm25_raw: number }>([
        {
          $search: {
            index: "facts_text",
            text: { query: queryLemmatized, path: "text_lemmatized" },
          },
        },
        { $limit: factCount }, // capture the full distribution, not top-K
        { $project: { _id: 1, bm25_raw: { $meta: "searchScore" } } },
      ])
      .toArray();
    scores = hits.map((h) => h.bm25_raw);
  }

  const sample: ProbeSample = {
    question_id: item.question_id,
    question: item.question,
    query_term_count: termCount,
    fact_count: factCount,
    scores,
  };
  await fs.writeFile(outPath, JSON.stringify(sample));
  await closeMongo();
}

function formatTranscript(sessionId: string, date: string, turns: LMESession[]): string {
  const startedAt = isoFromDate(date);
  const header = `---\nid: ${sessionId}\nstarted_at: ${startedAt}\n---\n\n`;
  const body = turns
    .map((t, i) => {
      const turnId = `t-${String(i + 1).padStart(4, "0")}`;
      return `## ${turnId} ${t.role}\n${t.content.trim()}`;
    })
    .join("\n\n");
  return header + body + "\n";
}

function isoFromDate(raw: string): string {
  const s = raw
    .trim()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`).toISOString();
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, y, mo, dd, hh, mm, ss] = m;
    return `${y}-${mo}-${dd}T${hh}:${mm}:${ss ?? "00"}Z`;
  }
  return new Date("2024-01-01T00:00:00Z").toISOString();
}

// --------------------------------------------------------- Orchestrator

interface CliArgs {
  limit: number;
  data: string;
}

function parseArgs(): CliArgs {
  const a = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = a.indexOf(flag);
    return i === -1 ? fallback : (a[i + 1] ?? fallback);
  };
  return {
    limit: Number(get("--limit", "20")),
    data: get("--data", path.join(benchRoot, "data/longmemeval_oracle.json")),
  };
}

function spawnWorker(itemPath: string, outPath: string, dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/kioku?directConnection=true";
    const u = new URL(base);
    u.pathname = `/${dbName}`;
    const child = spawn("npx", ["tsx", path.resolve(__dirname, "probe-bm25-scores.ts")], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        KIOKU_PROBE_WORKER: "1",
        KIOKU_PROBE_ITEM: itemPath,
        KIOKU_PROBE_OUT: outPath,
        MONGODB_URI: u.toString(),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
  });
}

async function dropDb(client: MongoClient, name: string): Promise<void> {
  await client.db(name).dropDatabase();
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

interface BucketStats {
  bucket: string;
  samples: number;
  query_count: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  // Old Okapi sigmoid params for this bucket, for reference.
  old_midpoint: number;
  old_steepness: number;
  // Theory-driven starting recalibration (~÷2.4 midpoint, ×2.4 steepness).
  proposed_midpoint: number;
  proposed_steepness: number;
}

function bucketKey(termCount: number): string {
  if (termCount <= 3) return "1-3";
  if (termCount <= 6) return "4-6";
  if (termCount <= 9) return "7-9";
  if (termCount <= 15) return "10-15";
  return "16+";
}

const OLD_PARAMS: Record<string, [number, number]> = {
  "1-3": [5.0, 0.7],
  "4-6": [7.0, 0.6],
  "7-9": [9.0, 0.5],
  "10-15": [10.0, 0.5],
  "16+": [12.0, 0.5],
};

async function orchestrate(): Promise<void> {
  const args = parseArgs();
  const dataset = JSON.parse(await fs.readFile(args.data, "utf8")) as LMEItem[];
  const items = dataset.slice(0, args.limit);
  console.log(`Probing BM25 score distribution on ${items.length} items.`);

  const tmpRoot = path.join(benchRoot, "tmp-probe");
  await fs.mkdir(tmpRoot, { recursive: true });

  const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/kioku?directConnection=true";
  const sharedClient = new MongoClient(uri);
  await sharedClient.connect();

  const samples: ProbeSample[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const qid = item.question_id;
    const dbName = dbNameFor(qid);

    // Fresh per-item state.
    await dropDb(sharedClient, dbName);

    const itemFile = path.join(tmpRoot, `${qid}.item.json`);
    const outFile = path.join(tmpRoot, `${qid}.out.json`);
    await fs.writeFile(itemFile, JSON.stringify(item));

    console.log(`[${i + 1}/${items.length}] ${qid}`);
    try {
      await spawnWorker(itemFile, outFile, dbName);
      const sample = JSON.parse(await fs.readFile(outFile, "utf8")) as ProbeSample;
      samples.push(sample);
      console.log(
        `     terms=${sample.query_term_count} facts=${sample.fact_count} ` +
          `top=${(sample.scores[0] ?? 0).toFixed(3)} median=${quantile(
            sample.scores
              .slice()
              .sort((x, y) => y - x)
              .reverse(),
            0.5,
          ).toFixed(3)}`,
      );
    } catch (err) {
      console.log(`     ERROR ${(err as Error).message}`);
    } finally {
      await fs.rm(itemFile, { force: true });
      await fs.rm(outFile, { force: true });
      await dropDb(sharedClient, dbName);
    }
  }

  await sharedClient.close();

  // Aggregate by bucket. We sample across the whole returned set —
  // for sigmoid tuning we care most about the top of the distribution
  // (where relevant docs land), so the p75/p90/max stats matter more
  // than the median.
  const byBucket = new Map<string, number[]>();
  const byBucketQueries = new Map<string, number>();
  for (const s of samples) {
    if (s.scores.length === 0) continue;
    const b = bucketKey(s.query_term_count);
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(...s.scores);
    byBucketQueries.set(b, (byBucketQueries.get(b) ?? 0) + 1);
  }

  const stats: BucketStats[] = [];
  for (const bucket of ["1-3", "4-6", "7-9", "10-15", "16+"]) {
    const all = byBucket.get(bucket) ?? [];
    if (all.length === 0) continue;
    const sorted = all.slice().sort((a, b) => a - b);
    const [oldMid, oldSteep] = OLD_PARAMS[bucket]!;
    stats.push({
      bucket,
      samples: all.length,
      query_count: byBucketQueries.get(bucket) ?? 0,
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
      max: sorted[sorted.length - 1]!,
      old_midpoint: oldMid,
      old_steepness: oldSteep,
      proposed_midpoint: Number((oldMid / 2.4).toFixed(2)),
      proposed_steepness: Number((oldSteep * 2.4).toFixed(2)),
    });
  }

  console.log("");
  console.log("## Distribution by query-term bucket");
  console.log("bucket   queries  samples   median    p75    p90    max  | old_mp/sp  -> proposed");
  for (const s of stats) {
    console.log(
      `${s.bucket.padEnd(7)}  ${String(s.query_count).padStart(6)}  ${String(s.samples).padStart(6)}  ` +
        `${s.median.toFixed(2).padStart(6)}  ${s.p75.toFixed(2).padStart(5)}  ${s.p90.toFixed(2).padStart(5)}  ${s.max.toFixed(2).padStart(5)}  ` +
        `|  ${s.old_midpoint}/${s.old_steepness}  ->  ${s.proposed_midpoint}/${s.proposed_steepness}`,
    );
  }

  const outPath = path.join(
    benchRoot,
    `bm25-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await fs.writeFile(outPath, JSON.stringify({ stats, samples }, null, 2));
  console.log("");
  console.log(`Wrote ${outPath}`);
}

if (process.env.KIOKU_PROBE_WORKER === "1") {
  runWorker().catch((e) => {
    process.stderr.write(`[probe worker] fatal: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  });
} else {
  orchestrate().catch((error) => {
    logger.fatal({ error }, "bm25 probe failed");
    process.exit(1);
  });
}
