// LongMemEval orchestrator. Iterates dataset items, spawns one worker
// subprocess per item with an isolated Mongo database (spliced into
// MONGODB_URI), then judges all predictions and writes a results JSON.
//
// See bench/longmemeval/README.md for setup and usage.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "ai";
import { MongoClient } from "mongodb";
import { model as defaultModel, llmEndpoint } from "../src/llm.js";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { logger } from "../src/logger.js";
import { computeCitationRecall } from "./citation-recall.js";

// Per-item DB names: each worker gets its own kioku DB so retrieval
// over fact A doesn't see facts from fact B. Sanitized to satisfy
// Mongo's DB-name rules (no /\. "$ etc.).
function dbNameFor(qid: string): string {
  const safe = qid.replace(/[^A-Za-z0-9_-]/g, "_");
  return `kioku_bench_${safe}`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const benchRoot = path.join(projectRoot, "bench/longmemeval");

interface CliArgs {
  limit: number;
  data: string;
  judgeModel: string | null;
  cleanVaults: boolean;
  keepVaults: boolean;
  resume: boolean;
  concurrency: number;
}

interface DatasetItem {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
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

interface JudgedItem extends WorkerResult {
  judge_verdict: boolean;
  judge_raw: string;
  // Set of evidence session ids the dataset says contain the answer.
  // Threaded through from the dataset so the results JSON is self-contained.
  answer_session_ids?: string[];
  // |citations ∩ answer_session_ids| / |answer_session_ids|. Undefined
  // when the dataset omits ground truth or supplies an empty list.
  citation_recall?: number;
}

interface TypeStats {
  correct: number;
  total: number;
  accuracy: number;
  // Mean citation recall over items in this type that have ground-truth
  // answer_session_ids. `cited` counts how many items contributed to the mean.
  citation_recall: number;
  cited: number;
}

interface Summary {
  total: number;
  correct: number;
  accuracy: number;
  // Mean citation recall over the subset of items with non-empty
  // answer_session_ids. `cited` is that subset's size.
  citation_recall: number;
  cited: number;
  by_type: Record<string, TypeStats>;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | null => {
    const i = args.indexOf(flag);
    if (i === -1) return fallback ?? null;
    return args[i + 1] ?? null;
  };
  const limit = Number(get("--limit", "5"));
  const data = get("--data", path.join(benchRoot, "data/longmemeval_oracle.json"))!;
  const judgeModel = get("--judge-model");
  const cleanVaults = args.includes("--clean-vaults");
  const keepVaults = args.includes("--keep-vaults");
  const resume = args.includes("--resume");
  const concurrency = Math.max(1, Number(get("--concurrency", "1")) || 1);
  return { limit, data, judgeModel, cleanVaults, keepVaults, resume, concurrency };
}

// Per-item predictions are persisted here as the bench progresses so a
// killed run can resume with --resume. Cleared once the bench completes.
const PARTIAL_PATH = path.join(benchRoot, "partial-predictions.json");

async function loadPartialPredictions(): Promise<WorkerResult[]> {
  try {
    return JSON.parse(await fs.readFile(PARTIAL_PATH, "utf8")) as WorkerResult[];
  } catch {
    return [];
  }
}

async function savePartialPredictions(predictions: WorkerResult[]): Promise<void> {
  await fs.mkdir(benchRoot, { recursive: true });
  await fs.writeFile(PARTIAL_PATH, JSON.stringify(predictions, null, 2));
}

// Bounded-concurrency pool. concurrency=1 reproduces the original serial
// behavior exactly (workers pull indices in order). Items are fully
// isolated (each its own vault DB), so parallel vs serial is
// result-identical — purely a wall-clock win for repeated benchmarking.
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

async function main() {
  const args = parseArgs();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const answererModel = process.env.MODEL ?? "(unset)";
  // JUDGE_MODEL (+ optional JUDGE_BASE_URL/JUDGE_API_KEY) pins a
  // provider-independent judge so a cross-provider answerer run (e.g. a
  // DeepSeek answerer on OpenRouter) is graded by the same model as the
  // OpenAI baseline. Unset → unchanged (judge defaults to the answerer).
  const judgeModelId = process.env.JUDGE_MODEL ?? args.judgeModel ?? answererModel;

  console.log(`# LongMemEval`);
  console.log(`Answerer: ${answererModel}`);
  console.log(`Judge:    ${judgeModelId}`);
  console.log(`Data:     ${args.data}`);
  console.log(`Limit:    ${args.limit}`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log("");

  const datasetRaw = await fs.readFile(args.data, "utf8");
  const parsed = JSON.parse(datasetRaw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Dataset at ${args.data} is not a JSON array. Got: ${typeof parsed}`);
  }
  const dataset = parsed as DatasetItem[];
  const items = dataset.slice(0, args.limit);
  console.log(`Loaded ${dataset.length} items, running ${items.length}`);
  console.log("");

  const itemsTmpRoot = path.join(benchRoot, "tmp");
  await fs.mkdir(itemsTmpRoot, { recursive: true });

  const predictions: WorkerResult[] = args.resume ? await loadPartialPredictions() : [];
  const alreadyDone = new Set(predictions.map((p) => p.question_id));
  if (args.resume) {
    console.log(`Resuming from ${predictions.length} previously completed items.`);
    console.log("");
  } else {
    // Fresh run wipes any stale partial state.
    await fs.rm(PARTIAL_PATH, { force: true });
  }

  const total = items.length;
  let completed = 0;
  // Serialize checkpoint writes — concurrent tasks must not interleave
  // writes to the single partial-predictions file.
  let saveChain: Promise<void> = Promise.resolve();
  const checkpoint = (): Promise<void> => {
    saveChain = saveChain.then(() => savePartialPredictions(predictions));
    return saveChain;
  };

  // Per-item drops share one Mongo client; pre-warm it so concurrent
  // tasks don't race the lazy connect.
  await ensureSharedClient();

  const processItem = async (item: DatasetItem, _index: number): Promise<void> => {
    const qid = item.question_id;
    if (alreadyDone.has(qid)) {
      completed += 1;
      console.log(`[${completed}/${total}] ${qid} (${item.question_type}) — SKIP (resumed)`);
      return;
    }

    const mongoDbName = dbNameFor(qid);
    if (!args.keepVaults) await dropMongoDb(mongoDbName);

    const itemFile = path.join(itemsTmpRoot, `${qid}.item.json`);
    const resultFile = path.join(itemsTmpRoot, `${qid}.result.json`);
    await fs.writeFile(itemFile, JSON.stringify(item));

    let line: string;
    try {
      await runWorker(itemFile, resultFile, mongoDbName);
      const result = JSON.parse(await fs.readFile(resultFile, "utf8")) as WorkerResult;
      predictions.push(result);
      const tag = result.error ? "ERROR" : "OK";
      line =
        `[${(completed += 1)}/${total}] ${tag} ${qid} (${item.question_type})  ` +
        `ingest=${result.ingestion_ms}ms query=${result.query_ms}ms\n` +
        `     pred:  ${truncate(result.prediction, 160)}\n` +
        `     truth: ${truncate(result.ground_truth, 160)}`;
    } catch (err) {
      predictions.push({
        question_id: qid,
        question_type: item.question_type,
        question: item.question,
        ground_truth: item.answer,
        prediction: "",
        citations: [],
        ingestion_ms: 0,
        query_ms: 0,
        error: (err as Error).message,
      });
      line = `[${(completed += 1)}/${total}] ERROR ${qid} (${item.question_type}): ${(err as Error).message}`;
    } finally {
      await fs.rm(itemFile, { force: true });
      await fs.rm(resultFile, { force: true });
      if (args.cleanVaults) await dropMongoDb(mongoDbName);
      // Checkpoint after every item so killing the bench doesn't lose work.
      await checkpoint();
    }
    // One atomic write so concurrent items don't interleave mid-line.
    console.log(line + "\n");
  };

  await runPool(items, args.concurrency, processItem);

  // Completion order under concurrency is nondeterministic; restore the
  // dataset order so judging and the results JSON stay stable/reproducible.
  const orderOf = new Map(items.map((it, idx) => [it.question_id, idx]));
  predictions.sort((a, b) => (orderOf.get(a.question_id) ?? 0) - (orderOf.get(b.question_id) ?? 0));

  // Map question_id → ground-truth answer_session_ids, used to compute
  // citation recall against the retrieval-side citations returned by
  // query(). Items without the field (or with an empty list) are
  // excluded from the recall mean.
  const truthById = new Map<string, string[] | undefined>(
    items.map((it) => [it.question_id, it.answer_session_ids]),
  );

  console.log(`## Judging ${predictions.length} predictions with ${judgeModelId}`);
  const judge = buildJudge(judgeModelId);
  const judged: JudgedItem[] = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i]!;
    const truth = truthById.get(p.question_id);
    const citation_recall = computeCitationRecall(p.citations, truth);
    if (p.error || !p.prediction) {
      judged.push({
        ...p,
        judge_verdict: false,
        judge_raw: "(no prediction)",
        ...(truth ? { answer_session_ids: truth } : {}),
        ...(citation_recall !== undefined ? { citation_recall } : {}),
      });
      continue;
    }
    const { verdict, raw } = await judge(p);
    judged.push({
      ...p,
      judge_verdict: verdict,
      judge_raw: raw,
      ...(truth ? { answer_session_ids: truth } : {}),
      ...(citation_recall !== undefined ? { citation_recall } : {}),
    });
    process.stdout.write(
      `  [${i + 1}/${predictions.length}] ${verdict ? "YES" : "no "} ${p.question_id}\n`,
    );
  }

  const summary = summarize(judged);
  console.log("");
  console.log("## Summary");
  console.log(
    `accuracy:        ${(summary.accuracy * 100).toFixed(1)}%  (${summary.correct}/${summary.total})`,
  );
  // When no items have ground truth, print "n/a" instead of "0.0%" so
  // a missing measurement is not confusable with a zero-recall result.
  const recallLine =
    summary.cited > 0
      ? `${(summary.citation_recall * 100).toFixed(1)}%  (mean over ${summary.cited} items with ground truth)`
      : "n/a  (no items had answer_session_ids)";
  console.log(`citation recall: ${recallLine}`);
  for (const [t, s] of Object.entries(summary.by_type)) {
    const recall =
      s.cited > 0 ? `cite=${(s.citation_recall * 100).toFixed(1)}% (${s.cited})` : "cite=n/a";
    console.log(
      `  ${t.padEnd(28)} acc=${(s.accuracy * 100).toFixed(1)}%  (${s.correct}/${s.total})  ${recall}`,
    );
  }

  const resultsRoot = path.join(benchRoot, "results");
  await fs.mkdir(resultsRoot, { recursive: true });
  const outPath = path.join(resultsRoot, `${startedAt.replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        model: answererModel,
        judge_model: judgeModelId,
        started_at: startedAt,
        duration_ms: Date.now() - t0,
        summary,
        items: judged,
      },
      null,
      2,
    ),
  );
  console.log("");
  console.log(`Wrote ${outPath}`);

  // Bench completed end-to-end — clear the resumable checkpoint.
  await fs.rm(PARTIAL_PATH, { force: true });

  // Close the shared Mongo client used by per-item dropDatabase calls.
  if (sharedClient) {
    await sharedClient.close();
    sharedClient = null;
  }
}

// Splice a per-item DB name into the configured MONGODB_URI's path while
// preserving host, port, and query string. The worker's mongo.ts then
// reads the DB name straight from the URI.
function uriWithDb(dbName: string): string {
  const base = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/kioku?directConnection=true";
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function runWorker(itemFile: string, resultFile: string, mongoDbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(projectRoot, "scripts/longmemeval-worker.ts");
    const child = spawn("npx", ["tsx", workerPath, "--item", itemFile, "--result", resultFile], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, MONGODB_URI: uriWithDb(mongoDbName) },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
  });
}

// Per-item Mongo cleanup. We keep one shared MongoClient across items
// so dropDatabase calls don't reconnect each time.
let sharedClient: MongoClient | null = null;
async function ensureSharedClient(): Promise<MongoClient> {
  if (!sharedClient) {
    const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/kioku?directConnection=true";
    sharedClient = new MongoClient(uri);
    await sharedClient.connect();
  }
  return sharedClient;
}
async function dropMongoDb(name: string): Promise<void> {
  const client = await ensureSharedClient();
  await client.db(name).dropDatabase();
}

type Judge = (p: WorkerResult) => Promise<{ verdict: boolean; raw: string }>;

function buildJudge(judgeModelId: string): Judge {
  // If the judge model differs from the default, build a fresh provider so
  // we don't accidentally reuse the answerer model. JUDGE_BASE_URL/
  // JUDGE_API_KEY (when set) point the judge at a different provider than
  // the answerer — e.g. keep an OpenAI gpt-4o-mini judge while the answerer
  // runs on OpenRouter — so cross-provider runs share one grader.
  const useDefault = !process.env.JUDGE_MODEL && judgeModelId === (process.env.MODEL ?? "");
  const judgeModel = useDefault
    ? defaultModel
    : createOpenAICompatible({
        name: "llm",
        baseURL: process.env.JUDGE_BASE_URL ?? llmEndpoint.baseURL,
        apiKey: process.env.JUDGE_API_KEY ?? llmEndpoint.apiKey,
        supportsStructuredOutputs: true,
      })(judgeModelId);

  return async (p: WorkerResult) => {
    // LongMemEval encodes abstention via a "_abs" suffix on question_id, not
    // question_type. e.g. "gpt4_70e84552_abs" → abstention=true.
    const abstention = /_abs$/.test(p.question_id);
    // Some LongMemEval items (notably multi-session) have list-shaped answers.
    // Normalize to a readable string before handing to the judge.
    const truthStr = Array.isArray(p.ground_truth)
      ? (p.ground_truth as unknown[]).map(String).join("; ")
      : String(p.ground_truth ?? "");
    const prompt = anscheckPrompt(p.question_type, p.question, truthStr, p.prediction, abstention);
    try {
      const { text } = await generateText({
        model: judgeModel,
        prompt,
        temperature: 0,
      });
      const raw = text.trim();
      const verdict = /\byes\b/i.test(raw);
      return { verdict, raw };
    } catch (err) {
      return { verdict: false, raw: `(judge error: ${(err as Error).message})` };
    }
  };
}

// Verbatim port of get_anscheck_prompt() from
// https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
function anscheckPrompt(
  task: string,
  question: string,
  answer: string,
  response: string,
  abstention: boolean,
): string {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (
    task === "single-session-user" ||
    task === "single-session-assistant" ||
    task === "multi-session"
  ) {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "temporal-reasoning") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "knowledge-update") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  // Unknown task — fall back to the default rubric so we still get a verdict.
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

function summarize(items: JudgedItem[]): Summary {
  const byType: Record<string, TypeStats> = {};
  let correct = 0;
  let recallSum = 0;
  let recallCount = 0;
  for (const it of items) {
    const t = it.question_type;
    byType[t] ??= { correct: 0, total: 0, accuracy: 0, citation_recall: 0, cited: 0 };
    byType[t].total += 1;
    if (it.judge_verdict) {
      byType[t].correct += 1;
      correct += 1;
    }
    if (it.citation_recall !== undefined) {
      byType[t].citation_recall += it.citation_recall;
      byType[t].cited += 1;
      recallSum += it.citation_recall;
      recallCount += 1;
    }
  }
  for (const v of Object.values(byType)) {
    v.accuracy = v.total > 0 ? v.correct / v.total : 0;
    v.citation_recall = v.cited > 0 ? v.citation_recall / v.cited : 0;
  }
  return {
    total: items.length,
    correct,
    accuracy: items.length > 0 ? correct / items.length : 0,
    citation_recall: recallCount > 0 ? recallSum / recallCount : 0,
    cited: recallCount,
    by_type: byType,
  };
}

function truncate(s: unknown, n: number): string {
  const stringify = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v == null) return "";
    if (
      typeof v === "number" ||
      typeof v === "boolean" ||
      typeof v === "bigint" ||
      typeof v === "symbol"
    ) {
      return String(v);
    }
    return JSON.stringify(v) ?? "";
  };
  const str = Array.isArray(s) ? s.map(stringify).join("; ") : stringify(s);
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

main().catch((error) => {
  logger.fatal({ error }, "longmemeval failed");
  process.exit(1);
});
