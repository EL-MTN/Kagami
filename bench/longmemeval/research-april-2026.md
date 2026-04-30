# Brainiac Memory Architecture — Research Report (April 2026)

Original research request: survey state-of-the-art agent-memory systems, identify what's likely to move Brainiac's accuracy from 64% on LongMemEval-100, and rank concrete architectural changes by leverage.

## Section 1 — State of the art

The April 2026 landscape sorts cleanly into four design philosophies. I'll characterize each on the four axes you asked for: storage shape, extraction, retrieval, and what they optimize for.

**GBrain (Garry Tan, MIT, April 2026).** The closest cousin to Brainiac. ~10,000 markdown files in a git repo as system of record, with PGLite + pgvector layered on top as a derived index. Extraction is a "dream cycle" — when a meeting transcript or email arrives, the agent detects entities, checks what the brain already knows, then updates the relevant pages. An overnight cron enriches and fixes citations. Retrieval is hybrid: BM25-style keyword for exact names + cosine for semantic, fused with Reciprocal Rank Fusion, then a cross-encoder rerank. Optimizes for: human-editable source of truth + low-latency retrieval. ([GBrain repo](https://github.com/garrytan/gbrain), [Gamgee writeup](https://gamgee.ai/blogs/garry-tan-gbrain-ai-memory-system/))

**Letta / MemGPT.** Two-tier "OS-style" memory: in-context "blocks" (Human, Persona, custom) the agent rewrites with `memory_replace`/`memory_insert`/`memory_rethink`, plus an out-of-context archival store accessed via `archival_memory_search`. Storage is Postgres-backed; extraction is implicit — the agent decides when to write. Retrieval is also agent-driven: search the archive when needed. With Sonnet 4.5 they shipped a unified "memory omni-tool". Optimizes for: stateful long-running agents and self-editing identity. ([Letta blog: Memory Blocks](https://www.letta.com/blog/memory-blocks), [MemGPT/Letta docs](https://docs.letta.com/concepts/memgpt/))

**mem0 (April 2025 paper, refined through 2026).** Two-stage extraction: (1) "Distill Memories" — single LLM pass producing ADD-only facts; (2) "Update" stage where a Conflict Detector flags overlapping/contradictory facts and an LLM Update Resolver picks ADD/MERGE/INVALIDATE/SKIP. The mem0ᵍ graph variant adds an Entity Extractor + Relations Generator. Retrieval is a 3-pass parallel score (semantic + keyword + entity) fused. Reports 93.4 on LongMemEval-S with ~1.8K tokens/call. Optimizes for: token efficiency + production latency. ([Mem0 paper](https://arxiv.org/abs/2504.19413), [Mem0 research](https://mem0.ai/research))

**Zep / Graphiti.** Bi-temporal knowledge graph (event time T + ingestion time T'), three hierarchical tiers (episode → entity → community subgraphs). Non-lossy: when facts contradict, both survive with validity intervals. Extraction is heavy LLM-based entity/relation extraction. Retrieval is graph traversal + embedding fallback. ~71.2% on LongMemEval-S in their original paper. Optimizes for: temporal correctness and audit trail. ([Zep paper](https://arxiv.org/abs/2501.13956), [Graphiti repo](https://github.com/getzep/graphiti))

**Cognee.** "Cognify" pipeline (classify → permission → chunk → LLM extract entities/relations → summarize → embed) plus a "Memify" graph-refinement pass that prunes stale nodes, reweights edges by usage, and adds derived facts. API surface is `remember/recall/forget/improve`. Optimizes for: self-improving graph that drifts toward useful structure. ([Cognee architecture blog](https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory))

**Supermemory.** Closer to RAG-as-a-service; less interesting as architectural inspiration but worth noting they cite SOTA-on-LongMemEval marketing claims. ([Supermemory research](https://supermemory.ai/research/))

**Emergence AI.** Carefully tuned RAG: session decomposition for value granularity, fact-augmented key expansion for indexing, and **time-aware query expansion** that restricts retrieval to a question-derived time window. 86% on LongMemEval at 5.65s median latency, beats Oracle GPT-4o (82.4%). The single most-cited result for "RAG done right." ([Emergence blog](https://www.emergence.ai/blog/sota-on-longmemeval-with-rag))

**ByteRover (2.1.5, 2026).** Reports 92.8% on LongMemEval-S at 1.6s. Closed system; little public detail beyond marketing. ([ByteRover blog](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval))

**Academic frontier — the names you should know:**

- **Memory-R1** (Yan et al., Aug 2025, v5 Jan 2026): RL-trained Memory Manager (ADD/UPDATE/DELETE/NOOP) + Answer Agent, both fine-tuned with PPO/GRPO. With only 152 training QA pairs they outperform mem0/Zep baselines on LoCoMo, MSC, and LongMemEval at 3B–14B scale. Important: shows the "what to write/update/delete" decision is the leverage point, not retrieval. ([arXiv 2508.19828](https://arxiv.org/abs/2508.19828))
- **MemR³** (Dec 2025): Memory retrieval as a closed-loop agent with three actions — `retrieve`, `reflect`, `answer` — plus an explicit "evidence-gap tracker" that names what's still missing. +7.29% over RAG baselines on LoCoMo. The pattern that matters: a model that *enumerates what it doesn't yet know* before deciding to retrieve more. ([arXiv 2512.20237](https://arxiv.org/abs/2512.20237))
- **A-MEM** (NeurIPS 2025): Zettelkasten-inspired agentic memory; each new note autonomously links to related notes at write time, building a graph without an explicit relation extractor. ([arXiv 2502.12110](https://arxiv.org/abs/2502.12110))
- **MemTree / H-MEM** (2025): Dynamic tree-structured memory; nodes hold aggregated text + abstraction levels. Shows hierarchical compression beats flat storage for multi-hop reasoning. ([MemTree](https://arxiv.org/abs/2410.14052), [H-MEM](https://arxiv.org/html/2507.22925v1))
- **Episodic Memory position paper** (Pink et al., Feb 2025): explicit thesis that the missing piece is *episodic* (timestamped, situational) memory, distinct from semantic. Argues for hierarchical episode → semantic consolidation. ([arXiv 2502.06975](https://arxiv.org/pdf/2502.06975))
- **MIRIX** (Jul 2025): multi-agent memory with separate Episodic/Semantic/Procedural memories and a router. Strong design language for splitting by memory type. ([arXiv 2507.07957](https://arxiv.org/pdf/2507.07957))
- **Reflective Memory Management** (ACL 2025): explicit reflection pass over stored memories before they're committed. ([ACL paper](https://aclanthology.org/2025.acl-long.413.pdf))
- **STITCH**: intent-aware retrieval where each stored episode carries a "contextual intent" cue (latent goal + action type + salient entity types), filtering retrieval by intent compatibility. ([arXiv 2601.10702](https://arxiv.org/html/2601.10702v1))

**Cline / Codex memory:** No published architecture worth reporting beyond ".clinerules / AGENTS.md"-style hand-curated context files. Useful as a lesson — IDE agents have largely *not* solved memory; they've mostly solved "stuff a curated file in the system prompt." That's closer to your `_core.md` than to anything else.

## Section 2 — Realistic ceiling for Brainiac's shape

Your architecture is *agentic graph traversal over markdown with no embeddings*, run on a local 35B-class model. Three things bound your ceiling:

**(a) Model-quality ceiling.** LongMemEval published baselines show Oracle GPT-4o at 82.4% and Oracle GPT-4o-mini around the high 60s. ([LongMemEval paper](https://arxiv.org/pdf/2410.10813)) "Oracle" means the gold evidence is handed to the model — so the gap to 100% is *answering*, not retrieval. GLM-4.7-flash is roughly GPT-4o-mini class, possibly weaker on long-context reasoning. **Your answering-side ceiling, with perfect retrieval, is roughly 70–75% on LongMemEval-S.** Anything above that requires a stronger model, not a better memory system.

**(b) Retrieval-quality penalty.** Real (non-oracle) systems give up 5–15 points to oracle. Mem0 hits 93.4 with their pipeline; Emergence's tuned RAG hits 86. These use cross-encoder rerank, time-aware filtering, and entity-link fusion that you've explicitly excluded. Your ripgrep + agentic-traversal stack should give up another ~10 points to oracle. **Net realistic Brainiac ceiling on 100-item Oracle subset: ~70%, maybe 75% with serious work.** You're at 64. There's a real ~10-point runway, but not 25.

**(c) Failure modes structurally hard for your shape:**

1. **Multi-hop temporal arithmetic** (your 13 wrong-ordering + 5 duration failures). The model has to *compute* "how many days between" or "what was true at time T". Markdown timeline helps but the model still has to do arithmetic. This is the published weakness of every system without a structured temporal index. ([LongMemEval paper](https://arxiv.org/pdf/2410.10813) — temporal reasoning is the lowest-scoring category for almost every entrant.) Time-aware query expansion gave Emergence +11.4% recall in this category. Your prohibition on heuristics makes the parallel hard but not impossible — see Section 3.
2. **Counting / aggregation across many entities** (your 7 counting failures). Agentic traversal sees ≤5 entities per query. If the answer requires counting 12 things, you literally cannot see them all. This is *fundamental* to your view-loop design — not an extraction issue.
3. **Knowledge updates** (a fact changes; the new value should be returned, not the old). Your design appends observations and keeps both. Without an explicit "this supersedes that" signal, the model has to infer recency from dates. mem0 and Zep both treat this as a first-class problem (`UPDATE`/`INVALIDATE` operations).
4. **Extremum questions** ("the longest", "the most recent"). Same root cause as counting — requires seeing the full set.

These four categories account for ~25 of your 36 failures. **Two of them (counting, extremum) are architectural to view-loop and won't be fixed by prompt tuning.**

## Section 3 — Patterns worth implementing

Ranked roughly by leverage-per-effort. All compatible with markdown-on-disk + LLM-only.

### 3.1 Episodic rollups: weekly + monthly summary files
**Mechanism.** Background pass (cron, or end-of-week trigger) reads the last 7 days of `timeline.md` + new observations, asks the LLM to produce a `episodes/2026-W17.md` file: a 200–400 word narrative summary of what happened that week, with wikilinks back to entities. Same again for monthly. The retrieval LLM gets the *index* of episode files in addition to `index.md`.
**Addresses.** Counting, extremum, multi-session aggregation. The LLM sees compact rollups instead of trying to enumerate 50 observations across 50 view calls.
**Cost.** ~1 day. One new prompt, one new ingestion path, schema change in `_core.md` to point at episodes.
**Risk.** Rollups drift from ground truth. Mitigation: rollups are *additive* — cite back to entities; the agent can still view source if needed.
**Validated.** [Position: Episodic Memory paper](https://arxiv.org/pdf/2502.06975), [MemTree](https://arxiv.org/abs/2410.14052), [H-MEM](https://arxiv.org/html/2507.22925v1), Zep's community subgraphs, Cognee's "Memify". This is the single most-converged-on pattern in 2025–2026 research.

### 3.2 Question-aware retrieval: classify before traverse
**Mechanism.** First LLM call classifies the question into a category (single-fact / temporal / counting / extremum / abstention-likely / off-topic). Each category gets a different retrieval strategy and prompt: temporal → start from `timeline.md`, possibly with an LLM-derived date window; counting → enumerate all entities of a relevant type from `index.md` before viewing; abstention-likely → require explicit evidence before answering, default to `bail`.
**Addresses.** Counting (forces enumeration before viewing), temporal (focuses model attention on dates), and the 2-stage failure you saw (`bail` removed). Crucially, the *router* preserves `bail` as the default for the abstention class.
**Cost.** 1–2 days. Adds ~one extra LLM call per query (~+1s on local). You can keep it cheap by using the same model with a tiny classifier prompt.
**Risk.** Wrong classification cascades. Mitigation: the agentic loop is still the fallback; the classifier just *biases* the prompt and tool surface.
**Validated.** [STITCH](https://arxiv.org/html/2601.10702v1), [Emergence's time-aware query expansion](https://www.emergence.ai/blog/sota-on-longmemeval-with-rag) (+11.4% on temporal), [MemR³'s router](https://arxiv.org/abs/2512.20237) (`retrieve`/`reflect`/`answer`).

### 3.3 Reflection / evidence-gap pass
**Mechanism.** After the agent has viewed entities and is about to call `answer`, force one extra LLM step: "Given the question and the evidence you've collected, list (a) what the question asks, (b) what facts you have, (c) what facts you'd still need to be confident. If (c) is non-empty, either view more or `bail`." This is exactly MemR³'s evidence-gap tracker.
**Addresses.** Confident-wrong answers (your 2-stage failure mode, recurring even at 64%), extraction-quality failures (model realizes the date it has doesn't match the question's date), and overall calibration.
**Cost.** 1–2 days. New prompt + an extra step in the tool loop.
**Risk.** Latency goes up ~30%. Local model may parrot the gap-tracker template without genuinely reflecting; pilot it on the 36 failures specifically.
**Validated.** [MemR³](https://arxiv.org/abs/2512.20237) (+7.29% over RAG baseline), [Reflective Memory Management ACL 2025](https://aclanthology.org/2025.acl-long.413.pdf), Reflexion lineage.

### 3.4 Two-pass extraction (extract → verify)
**Mechanism.** After your single-pass extraction produces candidates, run a *second* LLM call that gets the candidates + the original transcript and is asked: "For each candidate, is the quote present and does the headline accurately summarize it? Is the `event_date` correct? Output corrections." Discard or correct candidates that fail.
**Addresses.** Your 7 extraction-quality failures (event_date wrong, missing facts). These come from a single hot LLM pass with no second look; you're paying for them on every query forever after.
**Cost.** 1 day. One extra LLM call per transcript, only at ingest time (not in the hot retrieval path).
**Risk.** Doubles ingestion cost; on local model, ~30s extra per transcript. Acceptable for a write-once workload.
**Validated.** [mem0's two-stage extract+update pipeline](https://arxiv.org/html/2504.19413v1), [Memory-R1's Memory Manager](https://arxiv.org/abs/2508.19828), Reflective Memory Management. Universal in 2025+ systems.

### 3.5 Anchor / pinned-fact pattern
**Mechanism.** Every entity file gets an `anchor:` field in frontmatter (you have this in spec but it's empty). After N observations, an LLM pass synthesizes the anchor as a 1–2 sentence "current state" summary; the anchor is what `index.md` shows, replacing the raw observation count. The retrieval prompt gets `index.md + anchors` instead of just slugs.
**Addresses.** Knowledge updates (the anchor is *current*, not the full history; old beliefs visible in observations), context window pressure as the vault grows, and "first guess" quality (often the anchor *is* the answer).
**Cost.** 2–3 days. Anchor synthesis prompt + when-to-regenerate trigger (e.g. >5 new observations) + `index.md` rendering change.
**Risk.** Anchors go stale. Mitigation: simple staleness rule (regenerate when N new observations since last anchor) + Obsidian-editable so you can fix bad ones by hand.
**Validated.** Letta's memory blocks ([letta blog](https://www.letta.com/blog/memory-blocks)), GBrain's entity pages, Memory-R1's UPDATE operation.

### 3.6 Compaction (deferred until pain)
**Mechanism.** When an entity file exceeds N words (your specs.md says 3000), LLM rewrites the body: anchor at top, recent N observations verbatim, older observations folded into a paragraph summary that retains date hooks. Wikilinks preserved.
**Addresses.** Long-term context-window pressure on view calls. Not your current problem.
**Cost.** 2 days. **Don't ship this yet** — your specs explicitly defer it; your vault hasn't hit 3000-word entities. Mentioned for completeness.
**Validated.** MemTree, H-MEM, mem0's session decomposition.

### 3.7 RL-trained memory manager (Memory-R1 path)
**Mechanism.** Replace the deterministic ER append/create logic with a learned policy: ADD/UPDATE/DELETE/NOOP per candidate, trained via outcome-driven RL where outcome = downstream LongMemEval accuracy. Memory-R1 hit SOTA with only 152 training pairs.
**Addresses.** Knowledge updates, conflict resolution, longterm graph quality.
**Cost.** 2–4 weeks. Training infra, reward shaping, gradient access on GLM. Significant.
**Risk.** Local model fine-tuning is still rough on Apple Silicon; you'd realistically train via cloud and serve locally. Crosses your "no cloud in hot path" line only at training time, which is acceptable.
**Validated.** [Memory-R1](https://arxiv.org/abs/2508.19828) — beats mem0/Zep on three benchmarks at 3B–14B. The most academically defensible bet for *future* gains, but engineering-heavy.

### Patterns I'd explicitly *not* recommend you adopt

- BM25/embedding hybrid retrieval as primary mechanism — your stance is principled and works; mem0/GBrain results don't strictly show retrieval quality is the bottleneck for systems your size, they show *time-aware filtering* is.
- Heuristic helper tools (`date_diff`, `search_timeline`) — you tried this; -6 points. Confirms the pattern: small models get distracted by tool surface area. The router pattern (3.2) gets you the same gain with less prompt distraction because tool surface stays narrow per query class.
- Splitting the agent into select-then-answer two-stage — you tried this; -18. The agentic loop's `bail` is load-bearing as you noted. Don't kill it.

## Section 4 — Recommendations for Brainiac

Given (a) your 36-failure profile, (b) GLM-4.7-flash on Apple Silicon, (c) your 64% baseline, (d) markdown-on-disk constraint, here's what I'd ship, in order:

### 1. Question-aware retrieval router (3.2). Highest leverage.

**Why first:** It directly attacks ~18 of your 36 failures (13 temporal + 7 counting are exactly the categories that benefit from question-class-specific retrieval). It preserves `bail` (your hardest-won architectural insight). It's 1–2 days. It composes with everything else you do later.

**Mechanism in your stack:** Add a pre-`query` LLM call that classifies into {temporal, counting, extremum, single-fact, off-topic}. For temporal: prepend a date-window-extraction step, then bias the retrieval prompt toward `timeline.md` first. For counting/extremum: instruct the model to enumerate from `index.md` before viewing, and lift the 5-view cap to 10 for these classes only. For off-topic: lower the bar for `bail`. For single-fact: your current loop, unchanged.

**Expected lift:** +5 to +10 points based on Emergence's time-aware-expansion result and the structural fit to your failures.

### 2. Episodic rollups + anchors (3.1 + 3.5 combined). Medium leverage, compounds with #1.

**Why second:** Counting/extremum failures are partly architectural (view-loop sees ≤5 entities) — rollups give the agent *aggregated views* without scaling view calls. Anchors directly fix the knowledge-update class and shrink the index the agent reasons over. Rollups + anchors are the same pattern at different time scales (entity-level vs week-level). Build them together.

**Mechanism in your stack:** Add a `consolidate-rollup(period)` operation. Weekly: produce `episodes/<YYYY>-W<NN>.md`. Per-entity: add `anchor:` regeneration when an entity gains >5 new observations since last anchor. Update `index.md` rendering to show anchors. Update retrieval prompt to mention `episodes/` directory. The retrieval LLM gets a richer set of always-loaded summaries; entity files become the deep-dive layer.

**Expected lift:** +3 to +6, mostly on counting/extremum and on questions where the answer is a synthesis the agent never had to generate.

### 3. Two-pass extraction with verification (3.4). Smaller but durable.

**Why third:** Your 7 extraction-quality failures are *permanent debt* — every query against bad data inherits them. A second-pass verifier at ingest time pays once and amortizes forever. It's also the cheapest insurance against future ingestion-prompt changes regressing silently.

**Mechanism:** After your existing extraction, second LLM call gets candidates + original turns and outputs `{candidate_id, verdict: ok|fix|drop, corrected_event_date, corrected_quote}`. Apply corrections before ER. Log dropped candidates to `.memory/extraction-rejects.jsonl`.

**Expected lift:** +2 to +4 on your specific failure set, but more importantly raises the quality floor on every future query.

**Total expected envelope:** 64% → ~75–78%. That brushes against your structural ceiling (Section 2) — past that point you need either a stronger answering model or to relax the markdown-only / no-embeddings stance. **Don't try to shipping all three at once** — ship #1 first, re-bench, then #2, then #3, so you can actually attribute the gains.

### One thing to seriously reconsider

Your `bail` insight (it's load-bearing because it provides implicit calibration) is the most important architectural truth in your write-up. The MemR³ paper essentially formalizes exactly this — the agent's ability to say "evidence gap is non-empty, abstain" is what calibrates the system. **Add an explicit reflection step before `answer` (3.3) as a stretch fourth item.** It's the same pattern as `bail`, generalized: instead of bail-or-answer, the agent enumerates what it has and what's missing before committing. On a 100-item bench, this should mostly trade silent wrongs for `bail`s, which is the *correct* trade for a personal-memory system where wrong > silent.

## Sources

- [LongMemEval (arXiv 2410.10813)](https://arxiv.org/abs/2410.10813)
- [LongMemEval site](https://xiaowu0162.github.io/long-mem-eval/)
- [GBrain repo](https://github.com/garrytan/gbrain)
- [Gamgee: GBrain writeup](https://gamgee.ai/blogs/garry-tan-gbrain-ai-memory-system/)
- [Letta: Memory Blocks](https://www.letta.com/blog/memory-blocks)
- [Letta MemGPT docs](https://docs.letta.com/concepts/memgpt/)
- [Mem0 paper (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [Mem0 research blog](https://mem0.ai/research)
- [Zep paper (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956)
- [Graphiti repo](https://github.com/getzep/graphiti)
- [Cognee architecture](https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory)
- [Supermemory research](https://supermemory.ai/research/)
- [Emergence AI: SOTA on LongMemEval with RAG](https://www.emergence.ai/blog/sota-on-longmemeval-with-rag)
- [ByteRover blog](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval)
- [Memory-R1 (arXiv 2508.19828)](https://arxiv.org/abs/2508.19828)
- [MemR³ (arXiv 2512.20237)](https://arxiv.org/abs/2512.20237)
- [A-MEM (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [MemTree (arXiv 2410.14052)](https://arxiv.org/abs/2410.14052)
- [H-MEM (arXiv 2507.22925)](https://arxiv.org/html/2507.22925v1)
- [Position: Episodic Memory (arXiv 2502.06975)](https://arxiv.org/pdf/2502.06975)
- [MIRIX (arXiv 2507.07957)](https://arxiv.org/pdf/2507.07957)
- [Reflective Memory Management (ACL 2025)](https://aclanthology.org/2025.acl-long.413.pdf)
- [STITCH (arXiv 2601.10702)](https://arxiv.org/html/2601.10702v1)
- [Agent Memory Paper List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
