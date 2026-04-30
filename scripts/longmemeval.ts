// LongMemEval orchestrator. Iterates dataset items, spawns one worker
// subprocess per item with an isolated BRAINIAC_VAULT, then judges all
// predictions and writes a results JSON.
//
// See bench/longmemeval/README.md for setup and usage.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { model as defaultModel } from '../src/llm.js';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const benchRoot = path.join(projectRoot, 'bench/longmemeval');

interface CliArgs {
  limit: number;
  data: string;
  judgeModel: string | null;
  cleanVaults: boolean;
  resume: boolean;
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
}

interface Summary {
  total: number;
  correct: number;
  accuracy: number;
  by_type: Record<string, { correct: number; total: number; accuracy: number }>;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | null => {
    const i = args.indexOf(flag);
    if (i === -1) return fallback ?? null;
    return args[i + 1] ?? null;
  };
  const limit = Number(get('--limit', '5'));
  const data = get('--data', path.join(benchRoot, 'data/longmemeval_oracle.json'))!;
  const judgeModel = get('--judge-model');
  const cleanVaults = args.includes('--clean-vaults');
  const resume = args.includes('--resume');
  return { limit, data, judgeModel, cleanVaults, resume };
}

// Per-item predictions are persisted here as the bench progresses so a
// killed run can resume with --resume. Cleared once the bench completes.
const PARTIAL_PATH = path.join(benchRoot, 'partial-predictions.json');

async function loadPartialPredictions(): Promise<WorkerResult[]> {
  try {
    return JSON.parse(await fs.readFile(PARTIAL_PATH, 'utf8')) as WorkerResult[];
  } catch {
    return [];
  }
}

async function savePartialPredictions(predictions: WorkerResult[]): Promise<void> {
  await fs.mkdir(benchRoot, { recursive: true });
  await fs.writeFile(PARTIAL_PATH, JSON.stringify(predictions, null, 2));
}

async function main() {
  const args = parseArgs();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const answererModel = process.env.MODEL ?? '(unset)';
  const judgeModelId = args.judgeModel ?? answererModel;

  console.log(`# LongMemEval`);
  console.log(`Answerer: ${answererModel}`);
  console.log(`Judge:    ${judgeModelId}`);
  console.log(`Data:     ${args.data}`);
  console.log(`Limit:    ${args.limit}`);
  console.log('');

  const datasetRaw = await fs.readFile(args.data, 'utf8');
  const dataset = JSON.parse(datasetRaw);
  if (!Array.isArray(dataset)) {
    throw new Error(`Dataset at ${args.data} is not a JSON array. Got: ${typeof dataset}`);
  }
  const items = dataset.slice(0, args.limit);
  console.log(`Loaded ${dataset.length} items, running ${items.length}`);
  console.log('');

  const vaultsRoot = path.join(benchRoot, 'vaults');
  const itemsTmpRoot = path.join(benchRoot, 'tmp');
  await fs.mkdir(vaultsRoot, { recursive: true });
  await fs.mkdir(itemsTmpRoot, { recursive: true });

  const predictions: WorkerResult[] = args.resume ? await loadPartialPredictions() : [];
  const alreadyDone = new Set(predictions.map((p) => p.question_id));
  if (args.resume) {
    console.log(`Resuming from ${predictions.length} previously completed items.`);
    console.log('');
  } else {
    // Fresh run wipes any stale partial state.
    await fs.rm(PARTIAL_PATH, { force: true });
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const qid = item.question_id;
    if (alreadyDone.has(qid)) {
      console.log(`[${i + 1}/${items.length}] ${qid} (${item.question_type}) — SKIP (resumed)`);
      console.log('');
      continue;
    }
    console.log(`[${i + 1}/${items.length}] ${qid} (${item.question_type})`);

    const vault = path.join(vaultsRoot, qid);
    await fs.rm(vault, { recursive: true, force: true });
    await fs.mkdir(vault, { recursive: true });

    const itemFile = path.join(itemsTmpRoot, `${qid}.item.json`);
    const resultFile = path.join(itemsTmpRoot, `${qid}.result.json`);
    await fs.writeFile(itemFile, JSON.stringify(item));

    try {
      await runWorker(itemFile, resultFile, vault);
      const result: WorkerResult = JSON.parse(await fs.readFile(resultFile, 'utf8'));
      predictions.push(result);
      const tag = result.error ? 'ERROR' : 'OK';
      console.log(`     ${tag}  ingest=${result.ingestion_ms}ms  query=${result.query_ms}ms`);
      console.log(`     pred:  ${truncate(result.prediction, 160)}`);
      console.log(`     truth: ${truncate(result.ground_truth, 160)}`);
    } catch (err) {
      console.log(`     ERROR: ${(err as Error).message}`);
      predictions.push({
        question_id: qid,
        question_type: item.question_type,
        question: item.question,
        ground_truth: item.answer,
        prediction: '',
        citations: [],
        ingestion_ms: 0,
        query_ms: 0,
        error: (err as Error).message,
      });
    } finally {
      await fs.rm(itemFile, { force: true });
      await fs.rm(resultFile, { force: true });
      if (args.cleanVaults) {
        await fs.rm(vault, { recursive: true, force: true });
      }
      // Checkpoint after every item so killing the bench doesn't lose work.
      await savePartialPredictions(predictions);
    }
    console.log('');
  }

  console.log(`## Judging ${predictions.length} predictions with ${judgeModelId}`);
  const judge = buildJudge(judgeModelId);
  const judged: JudgedItem[] = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i]!;
    if (p.error || !p.prediction) {
      judged.push({ ...p, judge_verdict: false, judge_raw: '(no prediction)' });
      continue;
    }
    const { verdict, raw } = await judge(p);
    judged.push({ ...p, judge_verdict: verdict, judge_raw: raw });
    process.stdout.write(`  [${i + 1}/${predictions.length}] ${verdict ? 'YES' : 'no '} ${p.question_id}\n`);
  }

  const summary = summarize(judged);
  console.log('');
  console.log('## Summary');
  console.log(`accuracy: ${(summary.accuracy * 100).toFixed(1)}%  (${summary.correct}/${summary.total})`);
  for (const [t, s] of Object.entries(summary.by_type)) {
    console.log(`  ${t.padEnd(28)} ${(s.accuracy * 100).toFixed(1)}%  (${s.correct}/${s.total})`);
  }

  const resultsRoot = path.join(benchRoot, 'results');
  await fs.mkdir(resultsRoot, { recursive: true });
  const outPath = path.join(resultsRoot, `${startedAt.replace(/[:.]/g, '-')}.json`);
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
  console.log('');
  console.log(`Wrote ${outPath}`);

  // Bench completed end-to-end — clear the resumable checkpoint.
  await fs.rm(PARTIAL_PATH, { force: true });
}

function runWorker(itemFile: string, resultFile: string, vault: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(projectRoot, 'scripts/longmemeval-worker.ts');
    const child = spawn(
      'npx',
      ['tsx', workerPath, '--item', itemFile, '--result', resultFile],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, BRAINIAC_VAULT: vault },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
  });
}

type Judge = (p: WorkerResult) => Promise<{ verdict: boolean; raw: string }>;

function buildJudge(judgeModelId: string): Judge {
  // If the judge model differs from the default, build a fresh provider so
  // we don't accidentally reuse the answerer model.
  const baseURL = process.env.LMSTUDIO_URL ?? 'http://localhost:1234/v1';
  const apiKey = process.env.LMSTUDIO_API_KEY ?? 'lm-studio';
  const useDefault = judgeModelId === (process.env.MODEL ?? '');
  const judgeModel = useDefault
    ? defaultModel
    : createOpenAICompatible({
        name: 'lmstudio',
        baseURL,
        apiKey,
        supportsStructuredOutputs: true,
      } as Parameters<typeof createOpenAICompatible>[0])(judgeModelId);

  return async (p: WorkerResult) => {
    // LongMemEval encodes abstention via a "_abs" suffix on question_id, not
    // question_type. e.g. "gpt4_70e84552_abs" → abstention=true.
    const abstention = /_abs$/.test(p.question_id);
    // Some LongMemEval items (notably multi-session) have list-shaped answers.
    // Normalize to a readable string before handing to the judge.
    const truthStr = Array.isArray(p.ground_truth)
      ? (p.ground_truth as unknown[]).map(String).join('; ')
      : String(p.ground_truth ?? '');
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
  if (task === 'single-session-user' || task === 'single-session-assistant' || task === 'multi-session') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === 'temporal-reasoning') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === 'knowledge-update') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === 'single-session-preference') {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  // Unknown task — fall back to the default rubric so we still get a verdict.
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

function summarize(items: JudgedItem[]): Summary {
  const byType: Record<string, { correct: number; total: number; accuracy: number }> = {};
  let correct = 0;
  for (const it of items) {
    const t = it.question_type;
    byType[t] ??= { correct: 0, total: 0, accuracy: 0 };
    byType[t].total += 1;
    if (it.judge_verdict) {
      byType[t].correct += 1;
      correct += 1;
    }
  }
  for (const v of Object.values(byType)) {
    v.accuracy = v.total > 0 ? v.correct / v.total : 0;
  }
  return {
    total: items.length,
    correct,
    accuracy: items.length > 0 ? correct / items.length : 0,
    by_type: byType,
  };
}

function truncate(s: unknown, n: number): string {
  const str = typeof s === 'string'
    ? s
    : Array.isArray(s)
      ? s.map(String).join('; ')
      : s == null
        ? ''
        : String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
