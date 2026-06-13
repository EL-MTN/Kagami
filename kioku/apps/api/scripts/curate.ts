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
// NOTE: --mode entity and --policy consolidate are dry-run-only for now.
// --apply is refused for them until the apply path is hardened (category
// normalization on merges + a cross-group dedup sweep); consolidate also
// plans large destructive drops. Only the default cosine/curate path applies.

import "dotenv/config";
import {
  planCuration,
  applyCuration,
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

  // The entity grouping and the consolidate (durable-only) policy are
  // dry-run-only until the apply path is hardened — merge categories aren't
  // normalized to the enum yet, and consolidate plans large destructive
  // drops. Refuse --apply for them BEFORE planning, so a mistaken run doesn't
  // first burn LLM review calls over the live store. The default
  // cosine/curate --apply (the sanctioned mutation path) is unaffected.
  if (args.apply && (args.mode === "entity" || args.policy === "consolidate")) {
    const flags: string[] = [];
    if (args.mode === "entity") flags.push("--mode entity");
    if (args.policy === "consolidate") flags.push("--policy consolidate");
    console.error(
      `Refusing --apply with ${flags.join(" + ")}: these strategies are dry-run-only ` +
        "until the apply path is hardened (merge-category normalization + cross-group " +
        "dedup). Re-run without --apply to preview, or use the default cosine/curate for --apply.",
    );
    process.exitCode = 2;
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
    if (!args.json) console.log("\nDry run — nothing written. Re-run with --apply to execute.");
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
