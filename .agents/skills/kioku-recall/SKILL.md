---
name: kioku-recall
description: Test and benchmark Kioku's memory-recall quality. Use when changing ingest, retrieval, ranking, or the fact schema — or when a user reports "Kioku didn't find X", "the memory is wrong", "recall regressed", or "is this change a regression." Wraps the existing benchmark suite (LongMemEval), the ad-hoc retrieval probe (`POST /recall`), the BM25 calibration tool, and the consolidate-variance probe. Trigger phrases: "test recall", "run longmemeval", "is the memory working", "calibrate BM25", "variance probe", "did my change regress recall", "Kioku didn't find", "memory missed".
---

# kioku-recall — measure Kioku memory quality

Kioku's job is "given a query, return the right facts." Every nontrivial change to ingest (`consolidate.ts`), retrieval (`retrieval/ranker.ts`), or storage (`storage/facts.ts`) needs a measurement before merging. There's a layered toolkit — fast at the top, expensive at the bottom. Always start with the cheapest probe that can answer the question.

## The hierarchy

| Tool                                 | Cost              | What it tells you                                         |
| ------------------------------------ | ----------------- | --------------------------------------------------------- |
| `POST /recall`                       | ~1 LLM embed call | Does retrieval rank the right fact #1 for ONE query?      |
| `scripts/variance-probe.ts`          | N × consolidate   | Is consolidate's fact count stable across runs?           |
| `scripts/probe-bm25-scores.ts`       | Mid-cost          | Has the BM25 score range shifted? Re-tune sigmoid params. |
| `scripts/longmemeval.ts --limit 5`   | ~1 min, ~$0.20    | Smoke test on 5 items before committing time/$            |
| `scripts/longmemeval.ts --limit 100` | ~30 min, ~$2      | Full headline number — comparable to the 74% baseline     |

Run each from `kioku/apps/api/` unless noted. All require `.env` populated (LLM keys + MONGODB_URI).

## (1) Single-query retrieval check — fastest signal

`POST /recall` runs the hybrid ranker (cosine + BM25 + entity boost) over the live store without any LLM answer-generation. Use this when iterating on retrieval/ranking changes.

```bash
# Boot the API
npm run kioku:dev:api

# Probe a query
curl -sk -X POST https://api.kioku.localhost/recall \
  -H 'content-type: application/json' \
  -d '{"query":"what programming languages does Eric use","k":10}' | jq '.facts[] | {text, score}'
```

Optional body fields: `k` (default ~25, max 100), `since`/`until` (`YYYY-MM-DD`), `filters` (per `FiltersSchema`). The response is `{facts, total}` with facts already sorted by hybrid score.

If the expected fact isn't in the top-K, the issue is retrieval, not generation. If it IS there but `query` (the LLM answerer) still misses, the issue is the prompt/answerer.

## (2) Consolidate variance — is ingest stable?

`consolidate()` is a nondeterministic LLM call; repeated runs over identical transcripts give different fact counts. The variance probe replays every stored transcript through consolidate N times and reports the distribution. Use it to confirm a prompt/threshold change reduced variance (or didn't blow it up).

```bash
cd kioku/apps/api
set -a; . ./.env; set +a
npx tsx scripts/variance-probe.ts --runs 5
```

Output: per-run fact counts and the spread. A healthy result is a stationary band, not a monotone climb (which means the relevance filter is leaky) or a monotone crash (over-aggressive dedup).

**Heads up**: this WIPES the live `facts`/`entities`/derived collections between runs (keeps `transcripts` as source of truth). If the live store has facts you want to keep, dump or skip.

## (3) BM25 calibration — after corpus shifts

`getBm25Params` (the sigmoid that maps raw Atlas BM25 scores into the additive fusion range) is calibrated against the current corpus's score distribution. After bulk ingest, schema changes, or model swaps, raw scores can shift and the sigmoid gets out of band, suppressing or inflating BM25's contribution.

```bash
cd kioku/apps/api
npx tsx scripts/probe-bm25-scores.ts --limit 20
```

Output: per-item raw BM25 score samples + a bucketed distribution. Feed the new center/scale into `getBm25Params` (in `src/retrieval/scoring.ts`).

## (4) LongMemEval smoke test — 5 items, ~1 minute

Before committing time and OpenAI dollars to a 100-item run, sanity-check with `--limit 5`. If a change broke retrieval catastrophically, this catches it immediately.

```bash
cd kioku/apps/api

# One-time: download Oracle dataset (15MB)
mkdir -p bench/longmemeval/data
curl -L -o bench/longmemeval/data/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json

# All-OpenAI run (gpt-4o-mini + text-embedding-3-small — the most-tested config)
LLM_KIND=openai-compatible LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=$OPENAI_API_KEY \
  LLM_MODEL=gpt-4o-mini \
  EMBEDDING_KIND=openai-compatible EMBEDDING_BASE_URL=https://api.openai.com/v1 \
  EMBEDDING_API_KEY=$OPENAI_API_KEY EMBEDDING_MODEL=text-embedding-3-small \
  npx tsx scripts/longmemeval.ts --limit 5
```

Per-item state goes to `bench/longmemeval/tmp/`; the final result lands in `bench/longmemeval/results/<timestamp>.json`. Each item gets an isolated Mongo DB (`kioku_bench_<qid>`) so retrieval is scope-clean.

## (5) LongMemEval full — headline number

Same command, `--limit 100`. Takes ~30 min, costs a few dollars in OpenAI tokens. Useful when you're confident in your change and want the comparable number against the **74% baseline** (gpt-4o-mini + text-embedding-3-small on Oracle/100, per `kioku/docs/bench.md`).

Flags worth knowing:

- `--concurrency 6` — items are vault-isolated so parallel runs give identical results, just faster.
- `--keep-vaults` — skip ingest on re-runs (e.g. iterating on the query/judge prompt over the same haystack).
- `--resume` — pick up from `tmp/partial-predictions.json` if interrupted.
- `--judge-model gpt-4o` — override the judge model independently.

## Standard regression workflow

For any change to ingest/retrieval/ranking:

1. **Quick check**: 3–5 `POST /recall` queries for facts you KNOW should be findable. Confirms nothing is structurally broken.
2. **Variance probe** (if you touched `consolidate.ts`): N=5 runs, confirm the band is stationary.
3. **BM25 probe** (if you touched embeddings, the corpus, or BM25 itself): re-tune the sigmoid.
4. **Smoke bench**: `--limit 5`. Catches catastrophic regressions in a minute.
5. **Full bench**: `--limit 100`. Compare against 74%.

Skip steps that aren't relevant to your change — don't run the full bench on a typo fix.

## What to be careful of

- **The live store has been wiped before.** Per project memory, the working store was rebuilt from 6 transcripts after a regression saga. Before running anything that drops collections (`variance-probe.ts`, `longmemeval.ts` worker DBs), confirm with the user if they care about the current `kioku` DB. Bench items use isolated `kioku_bench_*` DBs and don't touch the main one — but `variance-probe.ts` DOES.
- **Cost discipline**: don't run `--limit 100` on a draft PR. Smoke first.
- **Comparable runs only**: bench numbers only compare against runs with the same models. Switching from gpt-4o-mini to gpt-4o invalidates the 74% baseline.
- **`bench.md` is the source of truth** for headline numbers and the regression history. Update it when a measured change moves the number.
