import fs from "node:fs/promises";
import { z } from "zod";
import { cosineSimilarity, generateObject } from "ai";
import { embedTexts, model } from "../llm.js";
import { paths } from "../paths.js";
import { lemmatizeForBm25 } from "../retrieval/text.js";
import {
  appendFacts,
  deleteFacts,
  newFactId,
  readFactsInScope,
  rewriteFact,
  type Fact,
} from "../storage/facts.js";
import { removeFactLinks, upsertEntitiesFromFacts } from "../storage/entities.js";
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
  entitiesUnlinked: number;
  entitiesRemoved: number;
}

let cachedSystemPrompt: string | null = null;
async function getSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  cachedSystemPrompt = await fs.readFile(`${paths.prompts}/curate.md`, "utf8");
  return cachedSystemPrompt;
}

// Union-find clustering over pairwise cosine >= CLUSTER_COSINE. Purely
// mechanical grouping so each LLM call sees a coherent neighborhood —
// the threshold gates context assembly, never a verdict.
export function clusterFacts(facts: Fact[], threshold: number = CLUSTER_COSINE): Fact[][] {
  const parent = facts.map((_, i) => i);
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
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      if (cosineSimilarity(facts[i]!.embedding, facts[j]!.embedding) >= threshold) {
        parent[find(j)] = find(i);
      }
    }
  }
  const byRoot = new Map<number, Fact[]>();
  for (let i = 0; i < facts.length; i++) {
    const root = find(i);
    const group = byRoot.get(root);
    if (group) group.push(facts[i]!);
    else byRoot.set(root, [facts[i]!]);
  }

  // Multi-member clusters are reviewed as units (split when oversized);
  // singletons are coalesced into review batches so they still get a
  // drop/rewrite judgment without one LLM call each.
  const groups: Fact[][] = [];
  const singletons: Fact[] = [];
  for (const group of byRoot.values()) {
    if (group.length === 1) {
      singletons.push(group[0]!);
      continue;
    }
    for (let i = 0; i < group.length; i += MAX_GROUP) {
      groups.push(group.slice(i, i + MAX_GROUP));
    }
  }
  for (let i = 0; i < singletons.length; i += SINGLETON_BATCH) {
    groups.push(singletons.slice(i, i + SINGLETON_BATCH));
  }
  return groups;
}

function renderGroup(group: Fact[]): string {
  const rows = group.map((f) => ({
    id: f.id,
    text: f.text,
    event_date: f.event_date,
    created_at: f.created_at,
    category: f.category ?? "",
  }));
  return `Memories:\n${JSON.stringify(rows, null, 1)}\n\nReturn one action list covering every id exactly once.`;
}

// A verdict is usable only when it covers the group's ids exactly once
// and every merge carries text. Anything else fails open to keep-all.
function validateVerdict(group: Fact[], actions: VerdictAction[]): string | null {
  const expected = new Set(group.map((f) => f.id));
  const seen = new Set<string>();
  for (const a of actions) {
    if (a.ids.length === 0) return `${a.kind} action with empty ids`;
    for (const id of a.ids) {
      if (!expected.has(id)) return `unknown id ${id}`;
      if (seen.has(id)) return `id ${id} covered twice`;
      seen.add(id);
    }
    if (a.kind === "merge" && a.text.trim().length === 0) return "merge with empty text";
  }
  if (seen.size !== expected.size) {
    return `verdict covered ${seen.size}/${expected.size} ids`;
  }
  return null;
}

export async function planCuration(scope: CurationScope = {}): Promise<CurationPlan> {
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
  const groups = clusterFacts(facts);
  plan.groups = groups.length;
  const systemPrompt = await getSystemPrompt();

  for (const group of groups) {
    let actions: VerdictAction[];
    try {
      const { object } = await generateObject({
        model,
        schema: CurationVerdict,
        system: systemPrompt,
        prompt: renderGroup(group),
        temperature: 0,
        abortSignal: AbortSignal.timeout(120_000),
      });
      actions = object.actions;
    } catch (error) {
      logger.warn({ error, groupSize: group.length }, "curation verdict failed — keeping group");
      plan.failedGroups += 1;
      plan.keep.push(...group.map((f) => f.id));
      continue;
    }

    const invalid = validateVerdict(group, actions);
    if (invalid) {
      logger.warn(
        { invalid, groupSize: group.length, actions },
        "curation verdict invalid — keeping group",
      );
      plan.failedGroups += 1;
      plan.keep.push(...group.map((f) => f.id));
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
          ...(a.category.trim() ? { category: a.category.trim() } : {}),
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

  if (plan.drops.length > 0) {
    const ids = plan.drops.map((d) => d.id);
    result.dropped = await deleteFacts(ids, actor);
    const links = await removeFactLinks(ids);
    result.entitiesUnlinked += links.unlinked;
    result.entitiesRemoved += links.removedEntities;
  }

  for (let i = 0; i < plan.merges.length; i++) {
    const m = plan.merges[i]!;
    const embedding = mergeEmbeddings[i]!;
    const members = m.ids.map((id) => byId.get(id)).filter((f): f is Fact => f !== undefined);
    if (members.length === 0) continue;

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
      // Entity sets can change with the text; relink from scratch.
      const links = await removeFactLinks([updated.id]);
      result.entitiesUnlinked += links.unlinked;
      result.entitiesRemoved += links.removedEntities;
      await upsertEntitiesFromFacts([updated]);
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
      metadata: { curated_from: m.ids },
      ...(m.category !== undefined
        ? { category: m.category }
        : newest.category !== undefined
          ? { category: newest.category }
          : {}),
    };
    await appendFacts([fact], actor);
    const memberIds = members.map((f) => f.id);
    result.mergedAway += await deleteFacts(memberIds, actor);
    result.merged += 1;
    const links = await removeFactLinks(memberIds);
    result.entitiesUnlinked += links.unlinked;
    result.entitiesRemoved += links.removedEntities;
    await upsertEntitiesFromFacts([fact]);
  }

  return result;
}
