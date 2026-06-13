// Single-item LongMemEval worker. Spawned as a subprocess by
// scripts/longmemeval.ts so each item gets an isolated vault.
//
// Inputs (CLI):
//   --item    path to a JSON file containing one LongMemEval item
//   --result  path where the JSON result line will be written
//
// Inputs (env):
//   MONGODB_URI  per-item Mongo URI (orchestrator splices a unique DB name
//                into the path before spawning each worker)
//   MODEL        local LM Studio model id
//
// Output: writes a JSON file at --result with the prediction + timings.

import fs from "node:fs/promises";

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
  answer_session_ids?: string[];
}

interface WorkerResult {
  question_id: string;
  question_type: string;
  question: string;
  ground_truth: string;
  prediction: string;
  citations: string[];
  ingestion_ms: number;
  query_ms: number;
  error?: string;
}

function parseArgs(): { itemPath: string; resultPath: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = args.indexOf(flag);
    if (i === -1 || i === args.length - 1) {
      throw new Error(`missing required arg: ${flag}`);
    }
    return args[i + 1]!;
  };
  return { itemPath: get("--item"), resultPath: get("--result") };
}

async function main() {
  const { itemPath, resultPath } = parseArgs();
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be set (orchestrator splices a per-item DB)");
  }

  const item = JSON.parse(await fs.readFile(itemPath, "utf8")) as LMEItem;

  // Lazy-import after env is set so mongo.ts picks up MONGODB_URI.
  const { ensureIndexes } = await import("../src/storage/indexes.js");
  const { getDb, closeMongo } = await import("../src/storage/mongo.js");
  const { consolidate } = await import("../src/ingest/consolidate.js");
  const { parseTranscript } = await import("../src/ingest/transcript.js");
  const { upsertTranscript } = await import("../src/storage/transcripts.js");
  const { query } = await import("../src/query/answer.js");

  // Per-item DB starts empty — build the indexes the storage + retrieval
  // layers depend on before any read/write. Idempotent for --keep-vaults
  // reruns (existing indexes are no-ops).
  await ensureIndexes();

  const sessions = item.haystack_sessions;
  const sessionIds = item.haystack_session_ids;
  const dates = item.haystack_dates;
  if (sessions.length !== sessionIds.length || sessions.length !== dates.length) {
    throw new Error(
      `length mismatch: sessions=${sessions.length} ids=${sessionIds.length} dates=${dates.length}`,
    );
  }

  const ingestStart = Date.now();
  // Skip ingest entirely when the per-item DB already has facts. Lets
  // bench reruns with --keep-vaults isolate query/judge changes without
  // paying for re-extraction. A vault that consolidation emptied is also
  // skipped via the bench_meta marker — factsCount alone can't tell
  // "consolidated to nothing" from "never ingested", and re-ingesting it
  // would corrupt that item's gate result.
  const db = await getDb();
  const factsCount = await db.collection("facts").countDocuments({});
  const consolidated =
    (await db.collection("bench_meta").countDocuments({ kind: "consolidated" })) > 0;
  const skipIngest = factsCount > 0 || consolidated;
  if (!skipIngest) {
    for (let i = 0; i < sessions.length; i++) {
      const sid = sessionIds[i]!;
      const transcript = parseTranscript(formatTranscript(sid, dates[i]!, sessions[i]!));
      await upsertTranscript({ transcript });
      process.stderr.write(
        `[worker ${item.question_id}] ingesting ${sid} (${sessions[i]!.length} turns)\n`,
      );
      await consolidate(transcript);
    }
  } else {
    process.stderr.write(`[worker ${item.question_id}] ingest skipped (facts already populated)\n`);
  }
  const ingestionMs = Date.now() - ingestStart;

  process.stderr.write(`[worker ${item.question_id}] querying\n`);
  const queryStart = Date.now();
  let prediction = "";
  let citations: string[] = [];
  let err: string | undefined;
  try {
    const r = await query(item.question);
    prediction = r.answer;
    citations = r.citations;
  } catch (e) {
    err = (e as Error).message;
  }
  const queryMs = Date.now() - queryStart;

  const result: WorkerResult = {
    question_id: item.question_id,
    question_type: item.question_type,
    question: item.question,
    ground_truth: item.answer,
    prediction,
    citations,
    ingestion_ms: ingestionMs,
    query_ms: queryMs,
    ...(err ? { error: err } : {}),
  };
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  await closeMongo();
  process.stderr.write(`[worker ${item.question_id}] done\n`);
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

// LongMemEval dates arrive as e.g. "2023/04/10 (Mon) 17:50" — slashes for
// the date, a parenthesized day-of-week, and a HH:MM time. Some sources may
// also be ISO already. Normalize to a valid ISO-8601 string.
function isoFromDate(raw: string): string {
  const s = raw
    .trim()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`).toISOString();
  // Convert "YYYY/MM/DD HH:MM[:SS]" → "YYYY-MM-DDTHH:MM[:SS]Z"
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, y, mo, dd, hh, mm, ss] = m;
    return `${y}-${mo}-${dd}T${hh}:${mm}:${ss ?? "00"}Z`;
  }
  const norm = s.replace(/\//g, "-").replace(" ", "T");
  const d = new Date(norm.endsWith("Z") ? norm : `${norm}Z`);
  if (isNaN(d.getTime())) {
    return new Date("2024-01-01T00:00:00Z").toISOString();
  }
  return d.toISOString();
}

main().catch((e) => {
  process.stderr.write(`[worker] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
