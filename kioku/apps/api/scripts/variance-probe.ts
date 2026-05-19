// Variance probe / regression harness.
//
// consolidate()'s extraction is a nondeterministic LLM call; the same
// transcripts yield a different fact count each run. This replays every
// stored transcript through consolidate() N times (wiping derived
// collections between runs, keeping transcripts as source-of-truth) and
// reports the distribution. Use it to (a) confirm the relevance filter
// lowers the junk mean and (b) watch the spread — a stationary band, not
// a runaway, is the expected/healthy shape.
//
//   (cd kioku/apps/api && set -a && . ./.env && set +a &&
//    npx tsx scripts/variance-probe.ts --runs 5)

import { getDb } from "../src/storage/mongo.ts";
import { consolidate, type ConsolidateOptions } from "../src/ingest/consolidate.ts";
import type { Transcript } from "../src/types.ts";

interface TranscriptDoc {
  _id: string;
  user_id?: string;
  run_id?: string;
  agent_id?: string;
  started_at: string;
  turns: Transcript["turns"];
}

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

async function oneRun(): Promise<number> {
  const db = await getDb();
  await Promise.all([
    db.collection("facts").deleteMany({}),
    db.collection("entities").deleteMany({}),
    db.collection("history").deleteMany({}),
    db.collection("session_summaries").deleteMany({}),
  ]);
  const docs = await db
    .collection<TranscriptDoc>("transcripts")
    .find({})
    .sort({ started_at: 1 })
    .toArray();
  let total = 0;
  for (const d of docs) {
    const transcript: Transcript = {
      frontmatter: { id: d._id, started_at: d.started_at },
      turns: d.turns,
    };
    const opts: ConsolidateOptions = {
      ...(d.user_id !== undefined ? { user_id: d.user_id } : {}),
      ...(d.run_id !== undefined ? { run_id: d.run_id } : {}),
      ...(d.agent_id !== undefined ? { agent_id: d.agent_id } : {}),
    };
    total += (await consolidate(transcript, opts)).added;
  }
  return total;
}

async function main(): Promise<void> {
  const runs = arg("--runs", 5);
  const series: number[] = [];
  for (let i = 1; i <= runs; i++) {
    const n = await oneRun();
    series.push(n);
    console.log(`run ${i}/${runs}: ${n} facts`);
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  console.log(`\nseries: [${series.join(", ")}]`);
  console.log(`min=${min}  max=${max}  mean=${mean.toFixed(1)}  spread=${max - min}`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
