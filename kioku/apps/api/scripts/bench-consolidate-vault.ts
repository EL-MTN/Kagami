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
  const meta = db.collection("bench_meta");
  const fail = async (msg: string): Promise<never> => {
    process.stderr.write(`[consolidate ${db.databaseName}] ${msg}\n`);
    await closeMongo();
    process.exit(1);
  };

  // Idempotent: a `consolidate-all` retry after a transient failure must not
  // run the destructive durable-only pass a SECOND time on vaults that already
  // succeeded — that would drop/merge again and invalidate the A/B. Replay the
  // ORIGINAL stored result so the aggregate stays comparable to the baseline (a
  // fabricated zero-delta result would underreport the real drops/merges).
  const prior = await meta.findOne({ kind: "consolidated" });
  if (prior) {
    let payload = prior.result as Record<string, unknown> | undefined;
    if (!payload) {
      const facts = await db.collection("facts").countDocuments({});
      payload = {
        db: db.databaseName,
        model: process.env.LLM_MODEL ?? "(unset)",
        before: facts,
        after: facts,
        groups: 0,
        failedGroups: 0,
        plannedDrops: 0,
        plannedMerges: 0,
        applied: {},
      };
    }
    await fs.writeFile(
      resultPath,
      JSON.stringify({ ...payload, skipped: "already-consolidated" }, null, 2),
    );
    process.stderr.write(
      `[consolidate ${db.databaseName}] already consolidated — replaying result\n`,
    );
    await closeMongo();
    return;
  }

  // Require a SUCCESSFULLY-ingested vault — facts, not just transcripts. The
  // baseline writes the transcript BEFORE extracting, so an LLM/embedding
  // outage can leave transcripts populated with zero facts; marking that vault
  // would make the gate rerun skip ingest and query an empty store.
  const before = await db.collection("facts").countDocuments({});
  if (before === 0) {
    await fail(
      "zero facts — vault was not successfully ingested by the baseline; refusing to mark it",
    );
  }

  const plan = await planCuration({}, { grouping: "entity", policy: "consolidate" });

  // If every review group failed open (e.g. the consolidation model is down),
  // planCuration returns a keep-all plan and nothing was actually reviewed.
  // Applying + marking it would make the gate compare against an
  // unconsolidated store — treat it as a failed vault instead.
  if (plan.groups > 0 && plan.failedGroups === plan.groups) {
    await fail(
      `all ${plan.groups} review groups failed open (model down?) — consolidation did not run; refusing to mark it`,
    );
  }

  const applied = await applyCuration(plan);
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

  // Mark the (ingested + reviewed) vault consolidated AND store the result, so
  // a `--keep-vaults` gate rerun skips ingest, and an idempotent retry replays
  // these ORIGINAL totals instead of a non-comparable zero-delta fabrication.
  await meta.updateOne(
    { kind: "consolidated" },
    { $set: { kind: "consolidated", result } },
    { upsert: true },
  );

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
