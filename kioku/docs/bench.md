# Benchmarks

Kioku ships with a [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., 2024) runner under `apps/api/bench/longmemeval/`. Each item is one question over a multi-session chat history; the runner ingests the haystack into a fresh isolated vault, calls `query()`, and judges the answer with the official LLM-judge prompt.

## Headline numbers

- **74%** on a 100-item LongMemEval-Oracle subset (gpt-4o-mini answerer + judge, OpenAI text-embedding-3-small, atlas-local). Down from the prior **78%** baseline. Temporal-reasoning recovered to baseline (80.0%); the 4pp net loss is concentrated in multi-session counting questions (65.0% vs. 72.5%).
- The multi-session regression is attributed to dropping the per-session "On YYYY-MM-DD, conversation covered: …" summary fact in commit `6803aae`. Those keyword-bag clauses were retrieval noise for most queries but acted as implicit session-presence markers for cross-session counting questions ("how many weddings did I attend?"). Confirmed by ablation: bumping the consolidate cosine threshold (0.92 → 0.97) and reverting the within-response prompt edit each move temporal-reasoning but leave multi-session pinned at 26/40 across three runs.
- **Earlier baselines (pre-changes):** 78% on a 100-item Oracle subset (gpt-4o-mini, lmstudio nomic embeddings); +2pp gain over a JSONL-era 76% from whole-corpus BM25 closing the recall ceiling on multi-session questions.
- **Head-to-head vs. mem0 OSS** (JSONL-era numbers, pre-Mongo): 76% / 76% on the same 100 question_ids, same models, mem0's v3 pipeline running its native top_k=200 vs. Kioku's top_k=50. mem0's widely-cited "91% OSS" headline uses gpt-5 + the full 500 questions; that operating point hasn't been run here.

## Layout

```
apps/api/bench/longmemeval/
├── README.md
├── data/        # downloaded LongMemEval JSON (gitignored)
├── results/     # per-run output (timestamped JSON)
├── tmp/         # interim per-item state (e.g. partial-predictions.json)
└── vaults/      # per-item kept facts (when --keep-vaults is used)

apps/api/scripts/
├── longmemeval.ts          # orchestrator — iterates items, spawns workers, runs judge
├── longmemeval-worker.ts   # single-item worker — ingest + query in an isolated Mongo DB
└── probe-bm25-scores.ts    # one-shot diagnostic — refit getBm25Params after corpus shifts
```

## One-time setup

The Oracle subset is 15 MB and contains only the evidence sessions for each question (no distractors). Use it for the first runs.

```sh
mkdir -p apps/api/bench/longmemeval/data
curl -L -o apps/api/bench/longmemeval/data/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
```

The full S subset (`longmemeval_s_cleaned.json`, 277 MB) and M subset (`longmemeval_m_cleaned.json`, 2.74 GB) live at the same URL prefix.

## Running

From `apps/api/`:

```sh
# All-local LM Studio + GLM-4.7-flash
LLM_PROVIDER=lmstudio MODEL=zai-org/glm-4.7-flash \
  npx tsx scripts/longmemeval.ts --limit 5

# All-OpenAI gpt-4o-mini + text-embedding-3-small (the most-tested config)
LLM_PROVIDER=openai MODEL=gpt-4o-mini \
  EMBEDDING_PROVIDER=openai EMBEDDING_MODEL=text-embedding-3-small \
  OPENAI_API_KEY=$OPENAI_API_KEY \
  npx tsx scripts/longmemeval.ts --limit 100

# Hybrid: OpenAI chat, local embeddings
LLM_PROVIDER=openai MODEL=gpt-4o-mini OPENAI_API_KEY=$OPENAI_API_KEY \
  EMBEDDING_PROVIDER=lmstudio EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5 \
  npx tsx scripts/longmemeval.ts --limit 100

# Reuse vaults from a prior run (skips ingest if the per-item Mongo DB already has facts)
... --limit 100 --keep-vaults
```

Flags:

- `--limit N` — number of items to run (default `5`)
- `--judge-model <id>` — override the judge (default: same as `MODEL`)
- `--data <path>` — dataset JSON path (default: `bench/longmemeval/data/longmemeval_oracle.json`)
- `--keep-vaults` — skip the per-item Mongo DB drop; reuse the existing facts for the query/judge passes (saves ingest cost on prompt iterations)
- `--clean-vaults` — delete each vault after its item finishes (default: kept on disk)
- `--resume` — pick up from `tmp/partial-predictions.json` if a prior run was interrupted

## Output

```
apps/api/bench/longmemeval/results/<timestamp>.json
```

Per-item record includes the question, ground truth, Kioku's prediction, judge verdict + raw text, and ingest/query latencies.

## Architecture

- `scripts/longmemeval.ts` — orchestrator. Iterates items, spawns one worker subprocess per item with an isolated `KIOKU_MONGO_DB`, then runs the judge pass.
- `scripts/longmemeval-worker.ts` — single-item worker. Parses each `haystack_session` into a `Transcript`, calls `consolidate()` to extract atomic facts into the per-item Mongo DB, then `query()`. Auto-skips ingest when the per-item DB already has facts (lets `--keep-vaults` cycle the query/judge layer cheaply).
- `scripts/citation-recall.ts` — `computeCitationRecall(citations, truth)` helper. Set-overlap recall used by the orchestrator's summary; lives in its own file so the test suite can import it without triggering the orchestrator's top-level `main()` call.

Per-item subprocesses give clean DB isolation without refactoring `apps/api/src/storage/mongo.ts` (which freezes the DB name at module load).

## BM25 calibration

The sigmoid that maps Lucene/Atlas raw BM25 scores into the additive fusion is empirical (`getBm25Params` in `apps/api/src/retrieval/scoring.ts`). After significant corpus-shape changes — different embedding model, dataset shift, query-length distribution drift — refit via:

```sh
npx tsx scripts/probe-bm25-scores.ts --limit 20
```

The probe is split into orchestrator (default) and per-item worker (`KIOKU_PROBE_WORKER=1`), same self-spawning pattern as the bench. It ingests a small slice of LongMemEval items, captures raw `$search` scores per question, and emits a bucketed distribution summary so you can update the table in `getBm25Params`. See [retrieval.md](retrieval.md) for the calibration target.

## Caveats

- **Self-judging bias**: by default the judge model is the same as the answerer. Cheap but biased — use `--judge-model` with a stronger model for headline numbers.
- **Citation recall is retrieval-side, not answerer-grounded.** `query()` now populates `citations` with the deduped source sessions of the top-K facts returned by the hybrid ranker (see `extractCitations` in `apps/api/src/query/answer.ts`). The bench computes `recall = |citations ∩ answer_session_ids| / |answer_session_ids|` per item and reports the mean. This scores retrieval coverage — whether the ranker pulled the evidence sessions into the answerer's context — not which facts the answerer actually leaned on. Per-answer grounding (which retrieved fact the LLM cited) is a separate concern and is not measured here.
- **Latency profile**: with OpenAI gpt-4o-mini, expect ~30–50 s per item end-to-end (ingest dominates); a full 100-item run is ~50 min and ~$5–7 in API. With local GLM-4.7-flash via LM Studio it's bound by local model speed.
- **Architecture lineage.** The pipeline shape, prompts, and additive scoring formula are closely modeled on [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks). Implementation is independent (pure TypeScript, no spaCy / Qdrant) but the contracts come from there.
