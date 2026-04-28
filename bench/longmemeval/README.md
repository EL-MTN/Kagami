# LongMemEval runner

Runs Brainiac against [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., 2024). Each item is one question over a multi-session chat history; the runner ingests the haystack into a fresh isolated vault, calls `query()`, then judges the answer with the official LLM-judge prompt.

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
# Smoke test: 5 items, default model from .env, judge with the same model.
MODEL=qwen/qwen-3-32b npx tsx scripts/longmemeval.ts --limit 5

# Full Oracle run.
MODEL=qwen/qwen-3-32b npx tsx scripts/longmemeval.ts --limit 500
```

Flags:
- `--limit N` — number of items to run (default: 5)
- `--judge-model <id>` — override the LM Studio model used for judging (default: same as `MODEL`)
- `--data <path>` — dataset JSON path (default: `bench/longmemeval/data/longmemeval_oracle.json`)
- `--keep-vaults` — keep per-item vaults under `bench/longmemeval/vaults/` for inspection (default: kept; use `--clean-vaults` to delete after each item)

## Output

```
bench/longmemeval/results/<timestamp>.json
```

Schema:

```json
{
  "model": "qwen/qwen-3-32b",
  "judge_model": "qwen/qwen-3-32b",
  "started_at": "2026-04-28T...",
  "duration_ms": 0,
  "summary": {
    "total": 5,
    "correct": 0,
    "accuracy": 0.0,
    "by_type": { "multi-session": { "correct": 0, "total": 0 } }
  },
  "items": [
    {
      "question_id": "...",
      "question_type": "multi-session",
      "question": "...",
      "ground_truth": "...",
      "prediction": "...",
      "citations": ["entities/..."],
      "judge_verdict": true,
      "judge_raw": "yes",
      "ingestion_ms": 0,
      "query_ms": 0
    }
  ]
}
```

## Architecture

- `scripts/longmemeval.ts` — orchestrator. Iterates items, spawns one worker subprocess per item with an isolated `BRAINIAC_VAULT`, then runs the judge pass.
- `scripts/longmemeval-worker.ts` — single-item worker. Writes each `haystack_session` as a `raw/<session_id>.md` transcript, calls `consolidate()` on each, then `query()`. Writes a JSON result file.

Per-item subprocesses give clean vault isolation without refactoring `paths.ts` (which freezes the vault root at module load).

## Caveats

- **Self-judging bias**: by default the judge model is the same as the answerer. Cheap but biased — use `--judge-model` with a stronger model for the headline number.
- **Citation recall is not computed.** Brainiac cites entity files (`entities/<slug>.md`); LongMemEval's `answer_session_ids` references sessions. Bridging requires reading observation `source:` lines out of cited entities — TODO.
- **Local-model latency** is the binding constraint. Expect ~15s/query + ~10s/session ingestion. A 5-item smoke run with average-sized haystacks is roughly 5–15 minutes.
