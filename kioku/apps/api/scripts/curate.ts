// Operator CLI for Kioku's LLM curation pass (src/ingest/curate.ts).
//
//   npx tsx scripts/curate.ts                 # dry run on the default vault
//   npx tsx scripts/curate.ts --apply         # apply the plan
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

import "dotenv/config";
import { planCuration, applyCuration, type CurationPlan } from "../src/ingest/curate.js";
import { relinkAllEntities } from "../src/storage/entities.js";
import { closeMongo } from "../src/storage/mongo.js";

interface Args {
  apply: boolean;
  json: boolean;
  relink: boolean;
  user?: string;
  run?: string;
  agent?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, json: false, relink: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--json") args.json = true;
    else if (a === "--relink") args.relink = true;
    else if (a === "--user") args.user = argv[++i];
    else if (a === "--run") args.run = argv[++i];
    else if (a === "--agent") args.agent = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printPlan(plan: CurationPlan): void {
  console.log(
    `\n${plan.total} facts · ${plan.groups} review groups` +
      (plan.failedGroups > 0 ? ` · ${plan.failedGroups} groups failed open (kept)` : ""),
  );
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

  const plan = await planCuration(scope);

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printPlan(plan);
  }

  if (!args.apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to execute.");
    return;
  }

  const result = await applyCuration(plan);
  console.log(
    `\nApplied: dropped=${result.dropped} rewritten=${result.rewritten} ` +
      `merged=${result.merged} (replacing ${result.mergedAway}) ` +
      `entityLinksRemoved=${result.entitiesUnlinked} entitiesRemoved=${result.entitiesRemoved}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void closeMongo());
