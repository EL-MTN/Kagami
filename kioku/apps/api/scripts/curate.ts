// Operator CLI for Kioku's LLM curation pass (src/ingest/curate.ts).
//
//   npx tsx scripts/curate.ts                 # dry run on the default vault
//   npx tsx scripts/curate.ts --apply         # apply the plan
//   npx tsx scripts/curate.ts --mode entity   # group review by shared
//                                             # entity instead of cosine
//                                             # (collapses fragmented
//                                             #  episodes; default cosine)
//   npx tsx scripts/curate.ts --policy consolidate
//                                             # durable-facts-only prompt:
//                                             # drops episodic chat-exhaust
//                                             # outright (default: curate,
//                                             # the conservative editor)
//   npx tsx scripts/curate.ts --user u1 --run r1 --agent a1
//   npx tsx scripts/curate.ts --json          # machine-readable plan
//   npx tsx scripts/curate.ts --relink        # repair entity links only
//                                             # (no LLM; idempotent upsert sweep)
//
// Dry run prints the plan and writes nothing. --apply re-plans and
// executes: drops + merges delete/replace facts (journaled in `history`
// as DELETE/UPDATE/ADD rows, actor "curate") and entity links are
// maintained. There is no undo beyond the history journal — run a dry
// pass first.
//
// --apply with --mode entity or --policy consolidate runs the hardened
// converging apply (consolidateToConvergence): merge categories are clamped
// to the fixed enum, and the pass repeats until the store stops changing so
// cross-group duplicates the first entity pass leaves behind get merged. The
// default cosine/curate --apply stays a single pass.

import "dotenv/config";
import {
  planCuration,
  applyCuration,
  consolidateToConvergence,
  type CurationPlan,
  type CurationPolicy,
  type GroupingStrategy,
} from "../src/ingest/curate.js";
import { relinkAllEntities } from "../src/storage/entities.js";
import { closeMongo } from "../src/storage/mongo.js";

interface Args {
  apply: boolean;
  json: boolean;
  relink: boolean;
  mode: GroupingStrategy;
  policy: CurationPolicy;
  user?: string;
  run?: string;
  agent?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    json: false,
    relink: false,
    mode: "cosine",
    policy: "curate",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") args.apply = true;
    else if (a === "--json") args.json = true;
    else if (a === "--relink") args.relink = true;
    else if (a === "--mode") {
      const v = argv[++i];
      if (v !== "cosine" && v !== "entity") {
        console.error("--mode must be 'cosine' or 'entity'");
        process.exit(2);
      }
      args.mode = v;
    } else if (a === "--policy") {
      const v = argv[++i];
      if (v !== "curate" && v !== "consolidate") {
        console.error("--policy must be 'curate' or 'consolidate'");
        process.exit(2);
      }
      args.policy = v;
    } else if (a === "--user" || a === "--run" || a === "--agent") {
      // A scope flag without a value must fail fast — silently treating
      // `--apply --user` as an empty scope would curate the default
      // vault (destructively) instead of the intended one.
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        console.error(`${a} requires a value`);
        process.exit(2);
      }
      if (a === "--user") args.user = v;
      else if (a === "--run") args.run = v;
      else args.agent = v;
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printPlan(plan: CurationPlan, mode: GroupingStrategy, policy: CurationPolicy): void {
  // Each surviving fact is either a keep or a merge result (multi-id
  // merges collapse n→1, single-id merges rewrite 1→1); drops vanish.
  const projected = plan.keep.length + plan.merges.length;
  console.log(
    `\n[${mode} grouping · ${policy} policy] ${plan.total} facts · ${plan.groups} review groups` +
      (plan.failedGroups > 0 ? ` · ${plan.failedGroups} groups failed open (kept)` : ""),
  );
  console.log(`Projected after apply: ${projected} facts (−${plan.total - projected})`);
  console.log(`\nKEEP   ${plan.keep.length}`);

  console.log(`DROP   ${plan.drops.length}`);
  for (const d of plan.drops) {
    console.log(`  - [${d.id.slice(0, 8)}] ${d.text}`);
    console.log(`      reason: ${d.reason}`);
  }

  console.log(`MERGE  ${plan.merges.length}`);
  for (const m of plan.merges) {
    const label = m.ids.length === 1 ? "rewrite" : `merge ${m.ids.length}`;
    console.log(`  - ${label}:`);
    for (let i = 0; i < m.ids.length; i++) {
      console.log(`      [${m.ids[i]!.slice(0, 8)}] ${m.memberTexts[i]}`);
    }
    console.log(`      => ${m.text}`);
    if (m.event_date) console.log(`      event_date: ${m.event_date}`);
    console.log(`      reason: ${m.reason}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scope = {
    ...(args.user !== undefined ? { user_id: args.user } : {}),
    ...(args.run !== undefined ? { run_id: args.run } : {}),
    ...(args.agent !== undefined ? { agent_id: args.agent } : {}),
  };

  if (args.relink) {
    const r = await relinkAllEntities({ user_id: scope.user_id ?? "default", ...scope });
    console.log(
      `Relinked entities: created=${r.created} linked=${r.linked} purgedEmpty=${r.purgedEmpty}`,
    );
    return;
  }

  // Entity grouping or the consolidate (durable-only) policy go through the
  // converging apply: a single entity pass leaves cross-group duplicates, so
  // repeat plan→apply until the store stops changing. The default cosine/curate
  // --apply stays a single pass (it has no cross-group residue to clean up).
  const useConvergence = args.mode === "entity" || args.policy === "consolidate";

  if (args.apply && useConvergence) {
    const r = await consolidateToConvergence(scope, { grouping: args.mode, policy: args.policy });
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const t = r.totals;
    console.log(
      `\n[${args.mode} grouping · ${args.policy} policy] converged=${r.converged} rounds=${r.rounds}`,
    );
    console.log(`Facts: ${r.before} → ${r.after} (−${r.before - r.after})`);
    r.perRound.forEach((p, i) =>
      console.log(
        `  round ${i + 1}: dropped=${p.dropped} merged=${p.merged} (replacing ${p.mergedAway}) ` +
          `rewritten=${p.rewritten} staleSkipped=${p.staleSkipped}`,
      ),
    );
    console.log(
      `Totals: dropped=${t.dropped} rewritten=${t.rewritten} merged=${t.merged} ` +
        `(replacing ${t.mergedAway}) staleSkipped=${t.staleSkipped} ` +
        `entityLinksRemoved=${t.entitiesUnlinked} entitiesRemoved=${t.entitiesRemoved}`,
    );
    if (!r.converged) {
      console.log(
        `\n⚠ Did not converge in ${r.rounds} rounds — residual duplicates may remain. Re-run to continue.`,
      );
    }
    return;
  }

  const plan = await planCuration(scope, { grouping: args.mode, policy: args.policy });

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printPlan(plan, args.mode, args.policy);
  }

  if (!args.apply) {
    // Keep --json output pure (pipeable) — the human trailer would break
    // a downstream parser.
    if (!args.json) {
      console.log("\nDry run — nothing written. Re-run with --apply to execute.");
      if (useConvergence) {
        console.log(
          "Note: --apply runs to convergence (repeats until the store is stable), so it will " +
            "likely drop/merge MORE than this single-pass preview shows.",
        );
      }
    }
    return;
  }

  const result = await applyCuration(plan);
  console.log(
    `\nApplied: dropped=${result.dropped} rewritten=${result.rewritten} ` +
      `merged=${result.merged} (replacing ${result.mergedAway}) ` +
      `staleSkipped=${result.staleSkipped} ` +
      `entityLinksRemoved=${result.entitiesUnlinked} entitiesRemoved=${result.entitiesRemoved}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void closeMongo());
