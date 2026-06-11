import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { getDb } from "./mongo.js";
import { embedTexts } from "../llm.js";
import { extractEntities } from "../retrieval/text.js";
import { readFactsInScope, type Fact } from "./facts.js";
import { logger } from "../logger.js";

// Per-vault entity store. Each row: an entity text + embedding + the
// set of fact ids that mention it. At query time, query entities are
// embedded and matched against this store via $vectorSearch; matches
// with similarity >= 0.5 contribute an additive boost to the score of
// their linked facts via the hybrid scoring layer.

interface EntityDoc {
  _id: string;
  text: string;
  // Case-insensitive upsert key. Indexed unique by ensureIndexes().
  text_lower: string;
  entity_type: string; // 'PROPER' | 'QUOTED'
  embedding: number[];
  linked_memory_ids: string[]; // sorted, deduped
}

async function entitiesCol(): Promise<Collection<EntityDoc>> {
  const db = await getDb();
  return db.collection<EntityDoc>("entities");
}

// For each fact, extract entities and either link the fact_id to an
// existing entity (case-insensitive text match) or create a new one.
// Embeds new entities in a single batched call to amortize the API
// round-trip.
//
// Race-safe by construction: each entity is touched by exactly one
// updateOne against the unique text_lower index. $setOnInsert seeds the
// row on insert; $addToSet appends linked_memory_ids on both insert and
// update paths. Two concurrent ingests touching the same entity end up
// with the union of their fact ids, never overwriting each other.
export async function upsertEntitiesFromFacts(
  facts: Fact[],
): Promise<{ created: number; linked: number }> {
  if (facts.length === 0) return { created: 0, linked: 0 };

  type Pending = { type: string; display: string; mems: Set<string> };
  const pending = new Map<string, Pending>();
  for (const f of facts) {
    const ents = extractEntities(f.text);
    for (const ent of ents) {
      const key = ent.text.trim().toLowerCase();
      if (!key) continue;
      let p = pending.get(key);
      if (!p) {
        p = { type: ent.type, display: ent.text, mems: new Set() };
        pending.set(key, p);
      }
      p.mems.add(f.id);
    }
  }
  if (pending.size === 0) return { created: 0, linked: 0 };

  const col = await entitiesCol();
  const keys = Array.from(pending.keys());

  // Find which keys already have a row, so we only embed the new ones.
  // A concurrent writer can still insert between this read and our
  // upsert; in that case our $setOnInsert is silently skipped (correct)
  // and our embedding is wasted (cheap).
  const existing = await col
    .find({ text_lower: { $in: keys } })
    .project<{ text_lower: string }>({ text_lower: 1 })
    .toArray();
  const existingSet = new Set(existing.map((e) => e.text_lower));

  let newKeys = keys.filter((k) => !existingSet.has(k));
  let newEmbeddings: number[][] = [];
  if (newKeys.length > 0) {
    try {
      newEmbeddings = await embedTexts(newKeys.map((k) => pending.get(k)!.display));
    } catch (error) {
      // Skip the new entities entirely rather than persisting empty
      // embeddings — an empty vector never matches $vectorSearch and,
      // since existing entities are never re-embedded, would stay
      // broken forever. Skipping is self-healing: the next mention of
      // the same entity (or a relinkAllEntities sweep) re-attempts the
      // embed. Existing-entity link updates below still proceed.
      logger.warn(
        { error, entityKeys: newKeys },
        "entity embedding failed — skipping new entities this pass",
      );
      newKeys = [];
    }
  }

  let created = 0;
  let linked = 0;

  const ops: Promise<void>[] = [];
  for (let i = 0; i < newKeys.length; i++) {
    const key = newKeys[i]!;
    const p = pending.get(key)!;
    const memIds = Array.from(p.mems);
    const embedding = newEmbeddings[i]!;
    ops.push(
      col
        .updateOne(
          { text_lower: key },
          {
            $setOnInsert: {
              _id: randomUUID(),
              text: p.display,
              text_lower: key,
              entity_type: p.type,
              embedding,
            },
            $addToSet: { linked_memory_ids: { $each: memIds } },
          },
          { upsert: true },
        )
        .then((r) => {
          if (r.upsertedCount > 0) created += 1;
          // `linked` was previously the count of *newly added* edges.
          // Tracking that exactly under $addToSet would require a
          // read-modify-write per row; settle for an upper-bound
          // approximation since this counter is metrics-only.
          linked += memIds.length;
        }),
    );
  }
  for (const key of keys) {
    if (!existingSet.has(key)) continue;
    const p = pending.get(key)!;
    const memIds = Array.from(p.mems);
    ops.push(
      col
        .updateOne({ text_lower: key }, { $addToSet: { linked_memory_ids: { $each: memIds } } })
        .then(() => {
          linked += memIds.length;
        }),
    );
  }
  await Promise.all(ops);
  return { created, linked };
}

// Repair sweep for the best-effort entity linking. Ingest swallows
// entity-upsert failures by design (a fact write must never fail on the
// boost channel), which can leave facts unlinked and entities missing.
// Re-running the upsert over every fact in scope is idempotent by
// construction ($setOnInsert / $addToSet), embeds only entities that
// don't exist yet, and restores any link the failure dropped. Also
// purges legacy empty-embedding rows so their entities re-embed.
// Invoked via `scripts/curate.ts --relink`.
export async function relinkAllEntities(scope: {
  user_id?: string;
  run_id?: string;
  agent_id?: string;
}): Promise<{ created: number; linked: number; purgedEmpty: number }> {
  const col = await entitiesCol();
  const facts = await readFactsInScope(scope);
  // Empty-embedding rows (written before the skip-on-failure guard)
  // block $setOnInsert from ever re-embedding them — drop them first;
  // the sweep below recreates them with real embeddings. Scoped runs
  // purge only rows whose every link is inside the scope: deleting a
  // row shared with out-of-scope facts would lose those links for good
  // (the sweep can only recreate from in-scope facts). Rows left behind
  // stay broken until an unscoped --relink.
  const inScopeIds = facts.map((f) => f.id);
  const purged = await col.deleteMany({
    embedding: { $size: 0 },
    linked_memory_ids: { $not: { $elemMatch: { $nin: inScopeIds } } },
  });
  let created = 0;
  let linked = 0;
  const BATCH = 50;
  for (let i = 0; i < facts.length; i += BATCH) {
    const r = await upsertEntitiesFromFacts(facts.slice(i, i + BATCH));
    created += r.created;
    linked += r.linked;
  }
  return { created, linked, purgedEmpty: purged.deletedCount };
}

// Curation removes/replaces facts; their ids must leave every entity's
// linked_memory_ids. Entities whose link set empties are deleted — an
// unlinked entity can still win the query-time $vectorSearch yet boosts
// nothing, so keeping it only burns a candidate slot.
export async function removeFactLinks(
  factIds: string[],
): Promise<{ unlinked: number; removedEntities: number }> {
  if (factIds.length === 0) return { unlinked: 0, removedEntities: 0 };
  const col = await entitiesCol();
  const r = await col.updateMany(
    { linked_memory_ids: { $in: factIds } },
    { $pull: { linked_memory_ids: { $in: factIds } } },
  );
  const del = await col.deleteMany({ linked_memory_ids: { $size: 0 } });
  return { unlinked: r.modifiedCount, removedEntities: del.deletedCount };
}

// Rewrite-path unlink: pull `factId` only from entities the rewritten
// text no longer mentions (`keepTextLowers` = the new text's entity
// keys). Rows the fact still mentions are never touched, so an entity
// whose only link is this fact survives a rewrite intact instead of
// being deleted and re-created (which would lose it outright if the
// re-create's embed call failed transiently).
export async function pruneFactLinks(
  factId: string,
  keepTextLowers: string[],
): Promise<{ unlinked: number; removedEntities: number }> {
  const col = await entitiesCol();
  const r = await col.updateMany(
    { linked_memory_ids: factId, text_lower: { $nin: keepTextLowers } },
    { $pull: { linked_memory_ids: factId } },
  );
  const del = await col.deleteMany({ linked_memory_ids: { $size: 0 } });
  return { unlinked: r.modifiedCount, removedEntities: del.deletedCount };
}
