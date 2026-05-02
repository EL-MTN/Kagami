import { embed, embedMany, cosineSimilarity } from 'ai';
import { getEmbeddingModel } from './llm.js';
import { listEntityIds, readEntity, parseObservations } from './entity_io.js';

export interface RankedCandidate {
  id: string;
  name: string;
  type: string;
  latestHeadline: string;
}

export type Ranker = (
  question: string,
  k: number,
) => Promise<RankedCandidate[]>;

export async function embedQuestion(q: string): Promise<number[]> {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: q,
    abortSignal: AbortSignal.timeout(5_000),
  });
  return embedding;
}

export async function embedEntities(
  texts: { id: string; text: string }[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (texts.length === 0) return out;
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values: texts.map((t) => t.text),
    maxParallelCalls: 8,
    abortSignal: AbortSignal.timeout(15_000),
  });
  for (let i = 0; i < texts.length; i++) {
    out.set(texts[i]!.id, embeddings[i]!);
  }
  return out;
}

export interface RankedObservation {
  entityId: string;
  entityName: string;
  entityType: string;
  date: string;
  eventDate: string;
  headline: string;
  quote: string;
  source: string;
}

export type ObservationRanker = (
  question: string,
  k: number,
) => Promise<RankedObservation[]>;

// Mem0-style atomic-fact retrieval: every observation gets its own embedding,
// top-K by cosine similarity to the question. Returns observations enriched
// with their source entity for citation.
export const defaultObservationRanker: ObservationRanker = async (
  question,
  k,
) => {
  const ids = await listEntityIds();
  if (ids.length === 0) return [];

  const rows: Array<{ key: string; obs: RankedObservation; text: string }> = [];
  for (const id of ids) {
    const { frontmatter, body } = await readEntity(id);
    const obsList = parseObservations(body);
    for (let i = 0; i < obsList.length; i++) {
      const o = obsList[i]!;
      const obs: RankedObservation = {
        entityId: id,
        entityName: frontmatter.name,
        entityType: frontmatter.type,
        date: o.date,
        eventDate: o.event_date,
        headline: o.headline,
        quote: o.quote,
        source: o.source,
      };
      rows.push({ key: `${id}#${i}`, obs, text: o.headline });
    }
  }
  if (rows.length === 0) return [];

  const [qEmb, embs] = await Promise.all([
    embedQuestion(question),
    embedEntities(rows.map((r) => ({ id: r.key, text: r.text }))),
  ]);

  const topKeys = rankByCosine(qEmb, embs, k);
  const byKey = new Map(rows.map((r) => [r.key, r.obs]));
  return topKeys.map((key) => byKey.get(key)!);
};

export function rankByCosine(
  qEmb: number[],
  entityEmbs: Map<string, number[]>,
  k: number,
): string[] {
  const scored: Array<{ id: string; sim: number }> = [];
  for (const [id, emb] of entityEmbs) {
    scored.push({ id, sim: cosineSimilarity(qEmb, emb) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k).map((s) => s.id);
}

// Picks the observation with the greatest event_date (or date when missing).
// Returns '' if the entity has no observations.
function latestHeadline(body: string): string {
  const obs = parseObservations(body);
  if (obs.length === 0) return '';
  let best = obs[0]!;
  for (const o of obs) {
    const a = o.event_date || o.date;
    const b = best.event_date || best.date;
    if (a > b) best = o;
  }
  return best.headline;
}

// Per-entity text follows the locked design decision: name+type with a recency
// hint, or aliases when the entity has no observations yet. Keeps the embedded
// surface tight so nomic's 768-dim signal isn't diluted.
function entityEmbedText(
  name: string,
  type: string,
  aliases: string[],
  headline: string,
): string {
  if (headline) return `${name} (${type}). Latest: ${headline}`;
  const aliasPart = aliases.length > 0 ? `. Aliases: ${aliases.join(', ')}` : '';
  return `${name} (${type})${aliasPart}`;
}

export const defaultRanker: Ranker = async (question, k) => {
  const ids = await listEntityIds();
  if (ids.length === 0) return [];

  const entries: Array<{
    id: string;
    name: string;
    type: string;
    latestHeadline: string;
    text: string;
  }> = [];
  for (const id of ids) {
    const { frontmatter, body } = await readEntity(id);
    const headline = latestHeadline(body);
    entries.push({
      id,
      name: frontmatter.name,
      type: frontmatter.type,
      latestHeadline: headline,
      text: entityEmbedText(
        frontmatter.name,
        frontmatter.type,
        frontmatter.aliases,
        headline,
      ),
    });
  }

  const [qEmb, entityEmbs] = await Promise.all([
    embedQuestion(question),
    embedEntities(entries.map((e) => ({ id: e.id, text: e.text }))),
  ]);

  const topIds = rankByCosine(qEmb, entityEmbs, k);
  const byId = new Map(entries.map((e) => [e.id, e]));
  return topIds.map((id) => {
    const e = byId.get(id)!;
    return {
      id: e.id,
      name: e.name,
      type: e.type,
      latestHeadline: e.latestHeadline,
    };
  });
};

// Persistent .memory/embeddings.jsonl cache deferred — current vaults
// (10–27 entities) embed in ~0.5–1s on demand. Add a cache when entity
// counts grow into the hundreds; the keying is (entity id, body hash).
