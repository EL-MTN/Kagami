// Driver for the LongMemEval recall gate's consolidation step.
//
// Between a baseline `longmemeval.ts --keep-vaults` run and the gate run, this
// applies the durable-only consolidation pass to every vault the bench
// ingested. It enumerates the same first-N dataset items the orchestrator runs,
// derives each item's vault DB (kioku_bench_<qid>), and spawns one
// bench-consolidate-vault.ts per vault with the DB spliced into MONGODB_URI and
// LLM_MODEL forced to the curation model. The gate run then `--keep-vaults`
// skips ingest and queries the reduced store, isolating the recall impact of
// durable-only consolidation.
//
// Usage:
//   MONGODB_URI=... npx tsx scripts/bench-consolidate-all.ts \
//     --limit 100 --model gpt-4.1 --concurrency 6
//
// Mirrors longmemeval.ts: same dbNameFor() sanitization, same uriWithDb()
// splice, same bounded-concurrency pool. Reads no src/ code itself (each vault
// subprocess does, after its env is set).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const benchRoot = path.join(projectRoot, "bench/longmemeval");

interface DatasetItem {
  question_id: string;
}

interface VaultResult {
  db: string;
  model: string;
  before: number;
  after: number;
  groups: number;
  failedGroups: number;
  plannedDrops: number;
  plannedMerges: number;
  applied: Record<string, number>;
}

// Identical to longmemeval.ts dbNameFor — keep in sync so the gate run reuses
// the same vaults the baseline run created.
function dbNameFor(qid: string): string {
  const safe = qid.replace(/[^A-Za-z0-9_-]/g, "_");
  return `kioku_bench_${safe}`;
}

// Identical to longmemeval.ts uriWithDb.
function uriWithDb(dbName: string): string {
  const base = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/kioku?directConnection=true";
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function parseArgs(): { limit: number; data: string; model: string; concurrency: number } {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | null => {
    const i = args.indexOf(flag);
    if (i === -1) return fallback ?? null;
    return args[i + 1] ?? null;
  };
  const limit = Number(get("--limit", "5"));
  const data = get("--data", path.join(benchRoot, "data/longmemeval_oracle.json"))!;
  const model = get("--model", "gpt-4.1")!;
  const concurrency = Math.max(1, Number(get("--concurrency", "6")) || 1);
  return { limit, data, model, concurrency };
}

async function runPool<T>(
  list: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, list.length));
  const worker = async (): Promise<void> => {
    for (let i = next++; i < list.length; i = next++) {
      await task(list[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

function runVault(dbName: string, resultPath: string, model: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectRoot, "scripts/bench-consolidate-vault.ts");
    const child = spawn("npx", ["tsx", scriptPath, "--result", resultPath], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, MONGODB_URI: uriWithDb(dbName), LLM_MODEL: model },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`vault exited ${code}`)),
    );
  });
}

async function main() {
  const args = parseArgs();
  console.log(`# Consolidate vaults (durable-only)`);
  console.log(`Model:       ${args.model}`);
  console.log(`Data:        ${args.data}`);
  console.log(`Limit:       ${args.limit}`);
  console.log(`Concurrency: ${args.concurrency}\n`);

  const dataset = JSON.parse(await fs.readFile(args.data, "utf8")) as DatasetItem[];
  const items = dataset.slice(0, args.limit);
  const tmpRoot = path.join(benchRoot, "tmp");
  await fs.mkdir(tmpRoot, { recursive: true });

  const results: VaultResult[] = [];
  let done = 0;
  await runPool(items, args.concurrency, async (item) => {
    const db = dbNameFor(item.question_id);
    const resultFile = path.join(tmpRoot, `${item.question_id}.consolidate.json`);
    try {
      await runVault(db, resultFile, args.model);
      const r = JSON.parse(await fs.readFile(resultFile, "utf8")) as VaultResult;
      results.push(r);
      console.log(
        `[${(done += 1)}/${items.length}] ${db}  ${r.before}→${r.after}  ` +
          `(drops=${r.plannedDrops} merges=${r.plannedMerges} failed=${r.failedGroups})`,
      );
    } catch (err) {
      console.log(`[${(done += 1)}/${items.length}] ${db}  ERROR: ${(err as Error).message}`);
    } finally {
      await fs.rm(resultFile, { force: true });
    }
  });

  const before = results.reduce((s, r) => s + r.before, 0);
  const after = results.reduce((s, r) => s + r.after, 0);
  const drops = results.reduce((s, r) => s + r.plannedDrops, 0);
  const merges = results.reduce((s, r) => s + r.plannedMerges, 0);
  const failed = results.reduce((s, r) => s + r.failedGroups, 0);
  console.log("\n## Summary");
  console.log(`vaults consolidated: ${results.length}/${items.length}`);
  console.log(
    `facts:  ${before} → ${after}  (−${before - after}, ${((1 - after / before) * 100).toFixed(1)}%)`,
  );
  console.log(`planned drops=${drops} merges=${merges} failedGroups=${failed}`);

  const outPath = path.join(tmpRoot, "consolidate-summary.json");
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        model: args.model,
        limit: args.limit,
        before,
        after,
        drops,
        merges,
        failed,
        vaults: results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outPath}`);

  // A gate that silently tolerates failed vaults would compare a PARTIAL
  // consolidation against the full baseline and draw a wrong conclusion.
  // Fail loudly so the run isn't mistaken for complete.
  const failedVaults = items.length - results.length;
  if (failedVaults > 0) {
    console.error(
      `\nFAILED: ${failedVaults}/${items.length} vault(s) did not consolidate — the gate is ` +
        "INCOMPLETE. Do not compare this partial run against the baseline; re-run the failed items.",
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`[consolidate-all] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
