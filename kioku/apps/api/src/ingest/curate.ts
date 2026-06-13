import fs from "node:fs/promises";
import { z } from "zod";
import { cosineSimilarity, generateObject, type LanguageModel } from "ai";
import { embedTexts, model } from "../llm.js";
import { normalizeCategory } from "./categories.js";
import { paths } from "../paths.js";
import { extractEntities, lemmatizeForBm25 } from "../retrieval/text.js";
import {
  appendFacts,
  deleteFacts,
  newFactId,
  readFactsInScope,
  rewriteFact,
  type Fact,
} from "../storage/facts.js";
import {
  pruneFactLinks,
  readEntityLinks,
  removeFactLinks,
  upsertEntitiesFromFacts,
  type EntityLink,
} from "../storage/entities.js";
import { logger } from "../logger.js";

// Kioku's LLM curation pass — the on-demand counterpart to ingest.
//
// Extraction is append-only and conservative; over time the store
// accretes conversational residue (play-by-play narration, transient
// states), paraphrased near-duplicates below the 0.97 cosine gate,
// roll-up/atomic double extractions, and same-day contradiction
// clusters. This pass re-reads the corpus with an LLM editor
// (prompts/curate.md) and applies its verdicts:
//
//   keep  — untouched
//   drop  — delete + history DELETE row + entity unlink
//   merge — n>=2: replace members with one rewritten fact (new id,
//           provenance in metadata.curated_from, history ADD + DELETEs);
//           n==1: in-place rewrite keeping the id (history UPDATE)
//
// Clustering is mechanical (cosine union-find) and exists only to hand
// the LLM coherent small groups — every judgment is the model's. Any
// malformed/incomplete verdict fails OPEN: the whole group is kept
// untouched, same default-keep posture as ingest/relevance.ts.

const CLUSTER_COSINE = 0.8;
const MAX_GROUP = 25;
const SINGLETON_BATCH = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Strict json_schema mode rejects optional properties (see the note on
// ExtractionResult in consolidate.ts), so every field is required and
// "" stands in for absent.
const CurationVerdict = z.object({
  actions: z.array(
    z.object({
      kind: z.enum(["keep", "drop", "merge"]),
      ids: z.array(z.string()),
      text: z.string(),
      event_date: z.string(),
      category: z.string(),
      reason: z.string(),
    }),
  ),
});

type VerdictAction = z.infer<typeof CurationVerdict>["actions"][number];

export interface CurationScope {
  user_id?: string;
  run_id?: string;
  agent_id?: string;
}

export interface PlannedDrop {
  id: string;
  text: string;
  reason: string;
}

export interface PlannedMerge {
  ids: string[];
  memberTexts: string[];
  text: string;
  event_date?: string;
  category?: string;
  reason: string;
}

export interface CurationPlan {
  scope: CurationScope;
  total: number;
  groups: number;
  failedGroups: number;
  keep: string[];
  drops: PlannedDrop[];
  merges: PlannedMerge[];
}

export interface CurationApplyResult {
  dropped: number;
  rewritten: number;
  merged: number;
  mergedAway: number;
  // Merges skipped because a member fact disappeared between plan and
  // apply — the verdict's text was composed from ALL members, so
  // applying it would resurrect the missing fact's content.
  staleSkipped: number;
  entitiesUnlinked: number;
  entitiesRemoved: number;
}

// Review policy → prompt file. "curate" is the conservative default-keep
// editor; "consolidate" applies the durability test and drops episodic
// chat-exhaust outright (durable-facts-only). Both share the keep/drop/
// merge action schema, so the verdict validation and apply path are
// policy-agnostic.
export type CurationPolicy = "curate" | "consolidate";
const POLICY_PROMPT: Record<CurationPolicy, string> = {
  curate: "curate.md",
  consolidate: "consolidate.md",
};

const promptCache = new Map<string, string>();
async function getSystemPrompt(file: string): Promise<string> {
  const cached = promptCache.get(file);
  if (cached !== undefined) return cached;
  const text = await fs.readFile(`${paths.prompts}/${file}`, "utf8");
  promptCache.set(file, text);
  return text;
}

export interface CurationGroup {
  members: Fact[];
  // True for a cosine cluster (related facts — merges allowed), false
  // for a singleton review batch (mechanically UNRELATED facts that
  // only share an LLM call — multi-id merges are forbidden there).
  clustered: boolean;
}

// Union-find clustering over pairwise cosine >= CLUSTER_COSINE. Purely
// mechanical grouping so each LLM call sees a coherent neighborhood —
// the threshold gates context assembly, never a verdict. Facts are
// partitioned by (user_id, run_id, agent_id) before clustering: merges
// must never cross a scope boundary, because the replacement fact can
// carry only one scope tuple and scope fields gate retrieval filters.
export function clusterFacts(facts: Fact[], threshold: number = CLUSTER_COSINE): CurationGroup[] {
  const partitions = new Map<string, Fact[]>();
  for (const f of facts) {
    const key = JSON.stringify([f.user_id, f.run_id ?? null, f.agent_id ?? null]);
    const p = partitions.get(key);
    if (p) p.push(f);
    else partitions.set(key, [f]);
  }

  const groups: CurationGroup[] = [];
  const singletons: Fact[] = [];
  for (const part of partitions.values()) {
    const parent = part.map((_, i) => i);
    function find(i: number): number {
      let r = i;
      while (parent[r]! !== r) r = parent[r]!;
      // Path compression.
      let c = i;
      while (parent[c]! !== r) {
        const next = parent[c]!;
        parent[c] = r;
        c = next;
      }
      return r;
    }
    for (let i = 0; i < part.length; i++) {
      for (let j = i + 1; j < part.length; j++) {
        if (cosineSimilarity(part[i]!.embedding, part[j]!.embedding) >= threshold) {
          parent[find(j)] = find(i);
        }
      }
    }
    const byRoot = new Map<number, Fact[]>();
    for (let i = 0; i < part.length; i++) {
      const root = find(i);
      const group = byRoot.get(root);
      if (group) group.push(part[i]!);
      else byRoot.set(root, [part[i]!]);
    }

    // Multi-member clusters are reviewed as units (split when
    // oversized); singletons are coalesced into review batches so they
    // still get a drop/rewrite judgment without one LLM call each.
    for (const group of byRoot.values()) {
      if (group.length === 1) {
        singletons.push(group[0]!);
        continue;
      }
      for (let i = 0; i < group.length; i += MAX_GROUP) {
        groups.push({ members: group.slice(i, i + MAX_GROUP), clustered: true });
      }
    }
  }
  // Singleton batches may mix scopes — harmless, since only per-fact
  // actions (keep/drop/single-id rewrite) are allowed in them.
  for (let i = 0; i < singletons.length; i += SINGLETON_BATCH) {
    groups.push({ members: singletons.slice(i, i + SINGLETON_BATCH), clustered: false });
  }
  return groups;
}

// Entity-based grouping — the alternative to clusterFacts() for the
// consolidation pass. Cosine union-find FRAGMENTS a single episode whose
// paraphrases drift below the threshold: an email-send narrative spreads
// across 0.80–0.94 cosine, so its facts land in different review calls
// and the request→fulfillment→confirmation collapse the prompt already
// knows never fires. Grouping by a SHARED ENTITY instead gathers the
// whole episode about "Wang Haoqi" or "Tech Weekly Meeting" into one
// call. Like clusterFacts, this is mechanical context-assembly only —
// every keep/drop/merge verdict stays the model's.
//
// Greedy max-coverage: repeatedly claim the entity with the most
// still-unassigned in-scope facts (>=2) as one group, so each fact lands
// in its largest co-occurring entity's group. Facts with no entity, or
// whose every co-entity is already claimed, fall to singleton review
// batches exactly like clusterFacts.
export function groupByEntity(facts: Fact[], entities: EntityLink[]): CurationGroup[] {
  // Same scope partitioning as clusterFacts: a multi-id merge must never
  // cross (user_id, run_id, agent_id), since the replacement fact carries
  // one scope tuple and scope fields gate retrieval filters.
  const partitions = new Map<string, Fact[]>();
  for (const f of facts) {
    const key = JSON.stringify([f.user_id, f.run_id ?? null, f.agent_id ?? null]);
    const p = partitions.get(key);
    if (p) p.push(f);
    else partitions.set(key, [f]);
  }

  const groups: CurationGroup[] = [];
  const singletons: Fact[] = [];

  for (const part of partitions.values()) {
    const byId = new Map(part.map((f) => [f.id, f]));
    const assigned = new Set<string>();

    // Candidate entity → in-partition fact ids (deduped). Links to facts
    // outside this partition or already curated away are dropped here.
    // `key` is a stable tie-break so equal-size clusters don't resolve by
    // Mongo's unsorted entity order (which would make grouping — and the
    // resulting merges — nondeterministic run to run).
    const candidates: Array<{ ids: string[]; key: string }> = [];
    for (const e of entities) {
      const ids = [...new Set(e.linked_memory_ids)].filter((id) => byId.has(id));
      if (ids.length >= 2) candidates.push({ ids, key: [...ids].sort().join(",") });
    }

    // Greedy: claim the largest still-open cluster each round, recomputing
    // open membership against `assigned` so a fact is grouped exactly once.
    // Ties on open size break by the stable key for deterministic output.
    for (;;) {
      let best: { open: string[]; key: string } | null = null;
      for (const c of candidates) {
        const open = c.ids.filter((id) => !assigned.has(id));
        if (open.length < 2) continue;
        if (
          best === null ||
          open.length > best.open.length ||
          (open.length === best.open.length && c.key < best.key)
        ) {
          best = { open, key: c.key };
        }
      }
      if (best === null) break;
      for (const id of best.open) assigned.add(id);
      const members = best.open.map((id) => byId.get(id)!);
      for (let i = 0; i < members.length; i += MAX_GROUP) {
        groups.push({ members: members.slice(i, i + MAX_GROUP), clustered: true });
      }
    }

    for (const f of part) if (!assigned.has(f.id)) singletons.push(f);
  }

  for (let i = 0; i < singletons.length; i += SINGLETON_BATCH) {
    groups.push({ members: singletons.slice(i, i + SINGLETON_BATCH), clustered: false });
  }
  return groups;
}

function renderGroup(group: CurationGroup): string {
  const rows = group.members.map((f) => ({
    id: f.id,
    text: f.text,
    event_date: f.event_date,
    created_at: f.created_at,
    category: f.category ?? "",
  }));
  const constraint = group.clustered
    ? ""
    : "\n\nThese memories are mechanically UNRELATED (they share this review batch, not a topic). Multi-id merges are forbidden here — only keep, drop, and single-id rewrites.";
  return `Memories:\n${JSON.stringify(rows, null, 1)}${constraint}\n\nReturn one action list covering every id exactly once.`;
}

// A verdict is usable only when it covers the group's ids exactly once
// and every merge carries text. Multi-id merges are additionally only
// legal inside a cosine cluster — a singleton review batch holds
// mechanically UNRELATED facts, and a model combining two of them would
// destroy both originals for one synthetic memory the clustering said
// don't belong together. Anything else fails open to keep-all.
function validateVerdict(group: CurationGroup, actions: VerdictAction[]): string | null {
  const expected = new Set(group.members.map((f) => f.id));
  const seen = new Set<string>();
  for (const a of actions) {
    if (a.ids.length === 0) return `${a.kind} action with empty ids`;
    for (const id of a.ids) {
      if (!expected.has(id)) return `unknown id ${id}`;
      if (seen.has(id)) return `id ${id} covered twice`;
      seen.add(id);
    }
    if (a.kind === "merge" && a.text.trim().length === 0) return "merge with empty text";
    if (a.kind === "merge" && a.ids.length > 1 && !group.clustered) {
      return `multi-id merge in a singleton batch (${a.ids.join(", ")})`;
    }
  }
  if (seen.size !== expected.size) {
    return `verdict covered ${seen.size}/${expected.size} ids`;
  }
  return null;
}

// Grouping strategy for the review pass. "cosine" (default) is the
// original pairwise union-find; "entity" groups by shared entity so a
// fragmented episode is reviewed as one unit (see groupByEntity).
export type GroupingStrategy = "cosine" | "entity";

export async function planCuration(
  scope: CurationScope = {},
  opts: { grouping?: GroupingStrategy; policy?: CurationPolicy; model?: LanguageModel } = {},
): Promise<CurationPlan> {
  const facts = await readFactsInScope({
    user_id: scope.user_id ?? "default",
    run_id: scope.run_id,
    agent_id: scope.agent_id,
  });

  const plan: CurationPlan = {
    scope,
    total: facts.length,
    groups: 0,
    failedGroups: 0,
    keep: [],
    drops: [],
    merges: [],
  };
  if (facts.length === 0) return plan;

  const byId = new Map(facts.map((f) => [f.id, f]));
  const groups =
    opts.grouping === "entity"
      ? groupByEntity(facts, await readEntityLinks())
      : clusterFacts(facts);
  plan.groups = groups.length;
  const systemPrompt = await getSystemPrompt(POLICY_PROMPT[opts.policy ?? "curate"]);

  for (const group of groups) {
    let actions: VerdictAction[];
    try {
      const { object } = await generateObject({
        model: opts.model ?? model,
        schema: CurationVerdict,
        system: systemPrompt,
        prompt: renderGroup(group),
        temperature: 0,
        abortSignal: AbortSignal.timeout(120_000),
      });
      actions = object.actions;
    } catch (error) {
      logger.warn(
        { error, groupSize: group.members.length },
        "curation verdict failed — keeping group",
      );
      plan.failedGroups += 1;
      plan.keep.push(...group.members.map((f) => f.id));
      continue;
    }

    const invalid = validateVerdict(group, actions);
    if (invalid) {
      logger.warn(
        { invalid, groupSize: group.members.length, actions },
        "curation verdict invalid — keeping group",
      );
      plan.failedGroups += 1;
      plan.keep.push(...group.members.map((f) => f.id));
      continue;
    }

    for (const a of actions) {
      if (a.kind === "keep") {
        plan.keep.push(...a.ids);
      } else if (a.kind === "drop") {
        for (const id of a.ids) {
          plan.drops.push({ id, text: byId.get(id)!.text, reason: a.reason });
        }
      } else {
        plan.merges.push({
          ids: a.ids,
          memberTexts: a.ids.map((id) => byId.get(id)!.text),
          text: a.text.trim(),
          ...(DATE_RE.test(a.event_date) ? { event_date: a.event_date } : {}),
          // Clamp the model's category to the fixed enum here, at plan time,
          // so the dry-run preview shows exactly what apply will write. The
          // consolidate/curate prompts ask the model to fix the category on
          // merge, and it readily invents off-enum tags ("correspondence",
          // "contacts") that would silently unmatch category-filtered recall.
          // An empty category is left unset so the apply path's
          // fallback-to-member-category still applies (don't force "misc").
          ...(a.category.trim() ? { category: normalizeCategory(a.category) } : {}),
          reason: a.reason,
        });
      }
    }
  }
  return plan;
}

export async function applyCuration(
  plan: CurationPlan,
  actor = "curate",
): Promise<CurationApplyResult> {
  const result: CurationApplyResult = {
    dropped: 0,
    rewritten: 0,
    merged: 0,
    mergedAway: 0,
    staleSkipped: 0,
    entitiesUnlinked: 0,
    entitiesRemoved: 0,
  };

  // Re-read inside apply so a stale plan can't resurrect concurrent edits.
  const scoped = await readFactsInScope({
    user_id: plan.scope.user_id ?? "default",
    run_id: plan.scope.run_id,
    agent_id: plan.scope.agent_id,
  });
  const byId = new Map(scoped.map((f) => [f.id, f]));

  // Embed every merged text in one batched call before any write — if
  // the embedding provider is down, the store is left untouched.
  const mergeTexts = plan.merges.map((m) => m.text);
  const mergeEmbeddings = await embedTexts(mergeTexts);

  // Drops whose target changed since planning are stale: the verdict
  // judged the OLD text, and deleting the rewritten content would
  // destroy something the model never saw. Already-missing targets are
  // simply done (no-op), not stale.
  const freshDrops: PlannedDrop[] = [];
  for (const d of plan.drops) {
    const current = byId.get(d.id);
    if (current === undefined) continue;
    if (current.text !== d.text) {
      logger.warn({ id: d.id }, "curation drop skipped — plan stale, fact text changed");
      result.staleSkipped += 1;
      continue;
    }
    freshDrops.push(d);
  }
  if (freshDrops.length > 0) {
    const ids = freshDrops.map((d) => d.id);
    result.dropped = await deleteFacts(ids, actor);
    const links = await removeFactLinks(ids);
    result.entitiesUnlinked += links.unlinked;
    result.entitiesRemoved += links.removedEntities;
  }

  for (let i = 0; i < plan.merges.length; i++) {
    const m = plan.merges[i]!;
    const embedding = mergeEmbeddings[i]!;
    const members = m.ids.map((id) => byId.get(id)).filter((f): f is Fact => f !== undefined);
    // Any missing OR changed member makes the whole merge stale: m.text
    // was written from ALL members as the model saw them, so applying it
    // with a member gone (or rewritten since) would resurrect deleted
    // content or overwrite newer content the model never judged. Skip
    // the action entirely — the survivors keep their current form and
    // the next curation run re-judges them.
    const changed = m.ids.some((id, idx) => byId.get(id)?.text !== m.memberTexts[idx]);
    if (members.length !== m.ids.length || changed) {
      logger.warn(
        { ids: m.ids, missing: m.ids.filter((id) => !byId.has(id)), changed },
        "curation merge skipped — plan stale (member missing or text changed)",
      );
      result.staleSkipped += 1;
      continue;
    }

    if (m.ids.length === 1) {
      // No-op rewrite (verdict restated the fact verbatim): skip the
      // write so history doesn't accrue old_text === new_text rows.
      const current = members[0]!;
      if (
        current.text === m.text &&
        (m.event_date === undefined || m.event_date === current.event_date) &&
        (m.category === undefined || m.category === current.category)
      ) {
        continue;
      }
      const updated = await rewriteFact(
        m.ids[0]!,
        {
          text: m.text,
          text_lemmatized: lemmatizeForBm25(m.text),
          embedding,
          ...(m.event_date !== undefined ? { event_date: m.event_date } : {}),
          ...(m.category !== undefined ? { category: m.category } : {}),
        },
        actor,
      );
      if (!updated) continue;
      result.rewritten += 1;
      // Relink BEFORE unlinking: upsert the new text's entities first
      // (existing rows just gain/keep the link even if the embed of any
      // brand-new entity fails), then prune the fact id only from
      // entities the rewrite no longer mentions. A destroy-then-recreate
      // order would let a transient embed failure permanently drop an
      // entity whose only link was this fact. Entity maintenance is the
      // repairable boost channel — a failure here is logged, never
      // thrown (--relink repairs).
      try {
        await upsertEntitiesFromFacts([updated]);
        const keep = extractEntities(updated.text).map((e) => e.text.trim().toLowerCase());
        const links = await pruneFactLinks(updated.id, keep);
        result.entitiesUnlinked += links.unlinked;
        result.entitiesRemoved += links.removedEntities;
      } catch (error) {
        logger.warn({ error, factId: updated.id }, "curation rewrite entity maintenance failed");
      }
      continue;
    }

    // n>=2: one replacement fact, members deleted. event_date falls back
    // to the earliest member (the underlying event), source_session and
    // category to the newest member's.
    const newest = members.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    const earliestDate = members.reduce(
      (d, f) => (f.event_date < d ? f.event_date : d),
      members[0]!.event_date,
    );
    // Carry forward member metadata — recall/query expose exact
    // metadata.* filters, so dropping keys would silently unmatch the
    // curated memory. Oldest→newest so a conflicting key resolves to
    // its latest value; curated_from is reserved for provenance.
    const mergedMeta: Record<string, unknown> = {};
    for (const f of [...members].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      if (f.metadata) Object.assign(mergedMeta, f.metadata);
    }
    const fact: Fact = {
      id: newFactId(),
      text: m.text,
      text_lemmatized: lemmatizeForBm25(m.text),
      user_id: newest.user_id,
      ...(newest.run_id !== undefined ? { run_id: newest.run_id } : {}),
      ...(newest.agent_id !== undefined ? { agent_id: newest.agent_id } : {}),
      created_at: new Date().toISOString(),
      event_date: m.event_date ?? earliestDate,
      source_session: newest.source_session,
      embedding,
      metadata: { ...mergedMeta, curated_from: m.ids },
      ...(m.category !== undefined
        ? { category: m.category }
        : newest.category !== undefined
          ? { category: newest.category }
          : {}),
    };
    await appendFacts([fact], actor);
    // Link the replacement's entities BEFORE removing the members'
    // links: existing entity rows gain the new fact id first, so
    // pulling the member ids afterwards can't empty-and-delete a row
    // the replacement still mentions — even when a transient embed
    // failure skips brand-new entities. The upsert must never abort the
    // merge: a thrown entity-store error between the replacement insert
    // and the member deletes would leave BOTH in the store (duplicate
    // memories). Entity links are the repairable channel; the fact
    // sequence is not.
    try {
      await upsertEntitiesFromFacts([fact]);
    } catch (error) {
      logger.warn({ error, factId: fact.id }, "curation merge entity upsert failed");
    }
    const memberIds = members.map((f) => f.id);
    result.mergedAway += await deleteFacts(memberIds, actor);
    result.merged += 1;
    try {
      const links = await removeFactLinks(memberIds);
      result.entitiesUnlinked += links.unlinked;
      result.entitiesRemoved += links.removedEntities;
    } catch (error) {
      logger.warn({ error, memberIds }, "curation merge entity unlink failed");
    }
  }

  return result;
}

export interface ConvergenceResult {
  // Apply rounds actually executed (a plan with no work runs zero applies).
  rounds: number;
  // True when the store reached a fixpoint; false when maxRounds was hit
  // with work still pending (the store may still hold residual duplicates —
  // re-run or raise maxRounds).
  converged: boolean;
  before: number;
  after: number;
  // Review-group stats from the FIRST planning round. Lets a caller (the
  // bench gate) distinguish a TOTAL fail-open — model down, every group kept,
  // firstFailedGroups === firstGroups — from a genuine no-op where there was
  // simply nothing to consolidate. Both otherwise present as rounds=0.
  firstGroups: number;
  firstFailedGroups: number;
  // Per-round apply results and their sum across all rounds.
  perRound: CurationApplyResult[];
  totals: CurationApplyResult;
}

function emptyApplyResult(): CurationApplyResult {
  return {
    dropped: 0,
    rewritten: 0,
    merged: 0,
    mergedAway: 0,
    staleSkipped: 0,
    entitiesUnlinked: 0,
    entitiesRemoved: 0,
  };
}

// Run the curation/consolidation pass repeatedly until the store reaches a
// fixpoint. A single entity-grouped pass can leave CROSS-GROUP duplicates: a
// subject mentioning several high-frequency entities (a routine that names a
// ticker, a brand, and a person) is split across those entities' groups by
// groupByEntity's greedy max-coverage, so two near-identical facts survive the
// first pass in different review calls. Re-running over the now-smaller store
// regroups those survivors together — they become each other's largest
// remaining co-entity cluster — and merges them. Fact count is monotonically
// non-increasing across rounds, so this terminates; maxRounds is a backstop
// against no-op-rewrite churn (a model restating text round to round).
//
// Each round re-reads the store inside planCuration/applyCuration, so every
// pass operates on real persisted embeddings — no hypothetical merge-result
// vectors. This is the sanctioned --apply path for the entity / consolidate
// strategies (the single-pass apply leaves the cross-group residue above).
export async function consolidateToConvergence(
  scope: CurationScope = {},
  opts: {
    grouping?: GroupingStrategy;
    policy?: CurationPolicy;
    model?: LanguageModel;
    maxRounds?: number;
    actor?: string;
  } = {},
): Promise<ConvergenceResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 4);
  const actor = opts.actor ?? "curate";
  const planOpts = {
    ...(opts.grouping !== undefined ? { grouping: opts.grouping } : {}),
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  };

  const countInScope = async (): Promise<number> =>
    (
      await readFactsInScope({
        user_id: scope.user_id ?? "default",
        run_id: scope.run_id,
        agent_id: scope.agent_id,
      })
    ).length;

  const before = await countInScope();
  const perRound: CurationApplyResult[] = [];
  let converged = false;
  let firstGroups = 0;
  let firstFailedGroups = 0;

  for (let round = 0; round < maxRounds; round++) {
    const plan = await planCuration(scope, planOpts);
    if (round === 0) {
      firstGroups = plan.groups;
      firstFailedGroups = plan.failedGroups;
    }
    // Nothing to do — the store is already a fixpoint for this policy.
    if (plan.drops.length === 0 && plan.merges.length === 0) {
      converged = true;
      break;
    }
    const result = await applyCuration(plan, actor);
    perRound.push(result);
    // The plan had work but the store didn't change (every action
    // stale-skipped, or only no-op rewrites). Applying again would spin —
    // treat it as the fixpoint.
    if (result.dropped === 0 && result.merged === 0 && result.rewritten === 0) {
      converged = true;
      break;
    }
  }

  const after = await countInScope();
  const totals = perRound.reduce((acc, r) => {
    acc.dropped += r.dropped;
    acc.rewritten += r.rewritten;
    acc.merged += r.merged;
    acc.mergedAway += r.mergedAway;
    acc.staleSkipped += r.staleSkipped;
    acc.entitiesUnlinked += r.entitiesUnlinked;
    acc.entitiesRemoved += r.entitiesRemoved;
    return acc;
  }, emptyApplyResult());

  return {
    rounds: perRound.length,
    converged,
    before,
    after,
    firstGroups,
    firstFailedGroups,
    perRound,
    totals,
  };
}
