// Single-vault durable-only consolidation, for the LongMemEval recall gate.
//
// Mutates ONE bench vault: runs the entity-grouped + "consolidate" (durable-
// facts-only) curation pass over the facts the orchestrator already ingested,
// so a subsequent `longmemeval.ts --keep-vaults` run queries the reduced store.
// Spawned once per vault by bench-consolidate-all.ts, mirroring how the
// orchestrator spawns longmemeval-worker.ts: the parent splices the per-item
// DB into MONGODB_URI and sets LLM_MODEL (gpt-4.1 — 4o-mini breaks merge
// atomicity) before spawning, so this process only reads env.
//
// Inputs (CLI):  --result  path where the JSON result line is written
// Inputs (env):  MONGODB_URI  per-vault DB (spliced by the parent)
//                LLM_MODEL    model for the curation judgments

import fs from "node:fs/promises";

function parseArgs(): { resultPath: string } {
  const args = process.argv.slice(2);
  const i = args.indexOf("--result");
  if (i === -1 || i === args.length - 1) throw new Error("missing required arg: --result");
  return { resultPath: args[i + 1]! };
}

async function main() {
  const { resultPath } = parseArgs();
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be set (parent splices a per-vault DB)");
  }

  // Lazy-import after env is set so mongo.ts / llm.ts read MONGODB_URI + LLM_MODEL.
  const { getDb, closeMongo } = await import("../src/storage/mongo.js");
  const { planCuration, applyCuration } = await import("../src/ingest/curate.js");

  const db = await getDb();
  // Only consolidate a vault the baseline actually ingested. Transcripts
  // persist even when consolidation later empties the facts, so they're the
  // reliable "was ingested" signal — a 0-fact vault could otherwise be a
  // never-run baseline item OR a real consolidation. Marking an
  // uninitialized vault would make the gate rerun skip ingest and query an
  // empty DB, reporting a false regression; fail loudly instead.
  const ingested = (await db.collection("transcripts").countDocuments({})) > 0;
  if (!ingested) {
    process.stderr.write(
      `[consolidate ${db.databaseName}] no transcripts — vault was not ingested by the ` +
        "baseline; refusing to consolidate/mark an uninitialized vault\n",
    );
    await closeMongo();
    process.exit(1);
  }
  const before = await db.collection("facts").countDocuments({});

  const plan = await planCuration({}, { grouping: "entity", policy: "consolidate" });
  const applied = await applyCuration(plan);

  // Mark the (ingested) vault consolidated so a `longmemeval.ts --keep-vaults`
  // gate rerun skips ingest even when consolidation emptied the facts — a real
  // ingested vault can legitimately consolidate to zero durable facts.
  await db
    .collection("bench_meta")
    .updateOne({ kind: "consolidated" }, { $set: { kind: "consolidated" } }, { upsert: true });

  const after = await db.collection("facts").countDocuments({});

  const result = {
    db: db.databaseName,
    model: process.env.LLM_MODEL ?? "(unset)",
    before,
    after,
    groups: plan.groups,
    failedGroups: plan.failedGroups,
    plannedDrops: plan.drops.length,
    plannedMerges: plan.merges.length,
    applied,
  };
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  await closeMongo();
  process.stderr.write(
    `[consolidate ${result.db}] ${before}→${after} ` +
      `(drops=${plan.drops.length} merges=${plan.merges.length} failed=${plan.failedGroups})\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[consolidate] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
