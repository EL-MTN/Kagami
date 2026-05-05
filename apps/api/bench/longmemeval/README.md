# LongMemEval runner

Runs Kioku against [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., 2024). Each item is one question over a multi-session chat history; the runner ingests the haystack into a fresh isolated vault, calls `query()`, then judges the answer with the official LLM-judge prompt.

## One-time setup — fetch the Oracle subset

The Oracle subset is 15 MB and contains only the evidence sessions for each question (no distractors). Use it for the first runs.

```sh
mkdir -p bench/longmemeval/data
curl -L -o bench/longmemeval/data/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
```

The full S subset (`longmemeval_s_cleaned.json`, 277 MB) and M subset (`longmemeval_m_cleaned.json`, 2.74 GB) live at the same URL prefix if you want them later.

## Run

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

- `--limit N` — number of items to run (default: 5)
- `--judge-model <id>` — override the model used for judging (default: same as `MODEL`)
- `--data <path>` — dataset JSON path (default: `bench/longmemeval/data/longmemeval_oracle.json`)
- `--keep-vaults` — skip the per-item Mongo DB drop; reuse the existing facts for the query/judge passes (saves ingest cost on prompt iterations)
- `--clean-vaults` — delete each vault after its item finishes (default: kept on disk)
- `--resume` — pick up from `partial-predictions.json` if a prior run was interrupted

## Output

```
bench/longmemeval/results/<timestamp>.json
```

Per-item record includes the question, ground truth, Kioku's prediction, judge verdict + raw text, and ingest/query latencies.

## Architecture

- `scripts/longmemeval.ts` — orchestrator. Iterates items, spawns one worker subprocess per item with an isolated `KIOKU_MONGO_DB`, then runs the judge pass.
- `scripts/longmemeval-worker.ts` — single-item worker. Parses each `haystack_session` into a `Transcript`, calls `consolidate()` to extract atomic facts into the per-item Mongo DB, then `query()`. Auto-skips ingest when the per-item DB already has facts (lets `--keep-vaults` cycle the query/judge layer cheaply).

Per-item subprocesses give clean DB isolation without refactoring `mongo.ts` (which freezes the DB name at module load).

## Caveats

- **Self-judging bias**: by default the judge model is the same as the answerer. Cheap but biased — use `--judge-model` with a stronger model for headline numbers.
- **Citation recall is not computed.** Kioku currently returns empty citations from `query()`; LongMemEval's `answer_session_ids` references sessions, but mapping is TODO.
- **Latency profile**: with OpenAI gpt-4o-mini, expect ~30–50s per item end-to-end (ingest dominates); a full 100-item run is ~50 min and ~$5–7 in API. With local GLM-4.7-flash via LM Studio it's bound by local model speed.
