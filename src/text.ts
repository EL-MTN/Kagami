// Text utilities for hybrid retrieval. Adapted from mem0's spaCy-based
// pipeline to pure TypeScript — same algorithm shape, lossier on edge
// cases (no POS tagging, no NER) but faithful enough for BM25 keyword
// matching and entity-boost on our scale.
//
// Lemmatization mirrors mem0/utils/lemmatization.py:
//   - lowercase + strip punctuation/stopwords
//   - reduce common suffixes (Porter-lite)
//   - preserve original -ing variant alongside the stem (mem0's trick
//     for noun/verb ambiguity: "meeting" the noun vs "meet" the verb)
//
// Entity extraction mirrors mem0/utils/entity_extraction.py for the two
// shapes that survive without spaCy:
//   - PROPER:  sequences of capitalized words
//   - QUOTED:  text inside single or double quotes
// COMPOUND and NOUN entity types require spaCy POS tagging — skipped.

const STOPWORDS = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his',
  'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'our', 's', 'she', 'so', 't', 'than', 'that', 'the',
  'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours', 'am', 'being', 'did', 'doing',
]);

const _GENERIC_CAPS = new Set<string>([
  'works', 'items', 'things', 'stuff', 'resources', 'options', 'tips',
  'ideas', 'steps', 'ways', 'methods', 'tools', 'features', 'benefits',
  'examples', 'details', 'notes', 'instructions', 'guidelines',
  'recommendations', 'suggestions', 'overview', 'summary', 'conclusion',
  'introduction', 'pros', 'cons', 'advantages', 'disadvantages',
]);

// Porter-lite: catches the common cases mem0's spaCy lemmatizer also
// reduces (plurals, -ing, -ed, -ly). Lossier on irregular forms but
// fine for keyword matching at our scale.
function stem(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith('sses')) return word.slice(0, -2);            // classes → class
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y'; // berries → berry
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  return word;
}

const TOKEN_RE = /[a-z0-9]+/g;

export function lemmatizeForBm25(text: string): string {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (STOPWORDS.has(tok)) continue;
    const stemmed = stem(tok);
    if (stemmed.length > 0) tokens.push(stemmed);
    // mem0's "-ing variant" trick: keep the original -ing form so noun
    // uses ("meeting") still match document occurrences.
    if (tok.endsWith('ing') && tok !== stemmed && tok.length > 4) {
      tokens.push(tok);
    }
  }
  return tokens.join(' ');
}

// Match runs of capitalized words (proper-noun phrases). Skips known
// generic capitalized words and avoids matching the first word of a
// sentence by requiring the run to be at least 4 chars or contain
// multiple words. Lossier than spaCy NER but cheap and deterministic.
const PROPER_RE = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g;
const QUOTED_RE = /"([^"\n]+)"|'([^'\n]+)'/g;

export type EntityType = 'PROPER' | 'QUOTED';
export interface Entity {
  type: EntityType;
  text: string;
}

export function extractEntities(text: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(PROPER_RE)) {
    const ent = m[1]!.trim();
    if (!ent) continue;
    const lower = ent.toLowerCase();
    // Skip single capitalized words that are just generic English.
    if (!ent.includes(' ')) {
      if (_GENERIC_CAPS.has(lower)) continue;
      if (STOPWORDS.has(lower)) continue;
      // Single short proper nouns are usually false positives from
      // sentence starts. Require ≥4 chars OR multi-word.
      if (ent.length < 4) continue;
    }
    const key = `PROPER:${lower}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'PROPER', text: ent });
  }

  for (const m of text.matchAll(QUOTED_RE)) {
    const ent = (m[1] ?? m[2] ?? '').trim();
    if (!ent || ent.length > 100) continue;
    const key = `QUOTED:${ent.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'QUOTED', text: ent });
  }

  return out;
}
