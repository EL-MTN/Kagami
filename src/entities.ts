import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from './paths.js';
import { embedTexts } from './embeddings.js';
import { extractEntities } from './text.js';
import type { Fact } from './facts.js';

// Per-vault entity store, mirroring mem0's entity_store collection.
// Each row: an entity text + embedding + the set of memory_ids that
// mention it. At query time, query entities are embedded and matched
// against this store; matches with sim >= 0.5 boost their linked
// memories via score_and_rank's entity_boost channel.

export interface Entity {
  id: string;
  text: string;
  entity_type: string;        // 'PROPER' | 'QUOTED'
  embedding: number[];
  linked_memory_ids: string[]; // sorted, deduped
}

export async function readEntities(): Promise<Entity[]> {
  try {
    const raw = await fs.readFile(paths.entities, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Entity);
  } catch {
    return [];
  }
}

export async function writeEntities(entities: Entity[]): Promise<void> {
  await fs.mkdir(path.dirname(paths.entities), { recursive: true });
  const lines =
    entities.map((e) => JSON.stringify(e)).join('\n') +
    (entities.length > 0 ? '\n' : '');
  await fs.writeFile(paths.entities, lines);
}

// For each fact, extract entities and either link the fact_id to an
// existing entity (case-insensitive text match) or create a new one.
// Embeds new entities in a single batched call to amortize the API
// round-trip. Mirrors mem0/memory/main.py:Phase 7 entity linking.
export async function upsertEntitiesFromFacts(
  facts: Fact[],
): Promise<{ created: number; linked: number }> {
  if (facts.length === 0) return { created: 0, linked: 0 };

  const existing = await readEntities();
  const byKey = new Map<string, Entity>();
  for (const e of existing) {
    byKey.set(e.text.trim().toLowerCase(), e);
  }

  // Collect (key → entity_type, display_text, set of memory_ids) for
  // every entity mentioned across the new facts.
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

  // Identify which keys are new (need embedding) vs existing (just link
  // additional memory_ids).
  const newKeys: string[] = [];
  const newTexts: string[] = [];
  for (const [key, p] of pending) {
    if (!byKey.has(key)) {
      newKeys.push(key);
      newTexts.push(p.display);
    }
  }

  let newEmbeddings: number[][] = [];
  if (newTexts.length > 0) {
    try {
      newEmbeddings = await embedTexts(newTexts);
    } catch (err) {
      console.error('[entities] embed failed:', (err as Error).message);
      return { created: 0, linked: 0 };
    }
  }

  let created = 0;
  let linked = 0;
  for (let i = 0; i < newKeys.length; i++) {
    const key = newKeys[i]!;
    const p = pending.get(key)!;
    const merged = Array.from(p.mems).sort();
    const ent: Entity = {
      id: randomUUID(),
      text: p.display,
      entity_type: p.type,
      embedding: newEmbeddings[i]!,
      linked_memory_ids: merged,
    };
    byKey.set(key, ent);
    created += 1;
    linked += merged.length;
  }

  for (const [key, p] of pending) {
    if (newKeys.includes(key)) continue;
    const ent = byKey.get(key)!;
    const set = new Set(ent.linked_memory_ids);
    for (const mid of p.mems) {
      if (!set.has(mid)) {
        set.add(mid);
        linked += 1;
      }
    }
    ent.linked_memory_ids = Array.from(set).sort();
  }

  await writeEntities(Array.from(byKey.values()));
  return { created, linked };
}
