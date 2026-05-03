// Text utilities for Kioku's hybrid retrieval layer.
//
// lemmatizeForBm25 collapses surface variation so BM25 keyword matching
// catches "attending" / "attended" / "attends" as the same term:
//   - lowercase + strip punctuation and stopwords
//   - Porter-lite suffix reduction (plurals, -ing, -ed, -ly)
//   - preserve the original -ing form alongside the stem so noun uses
//     ("meeting" the noun) still match document occurrences
//
// extractEntities pulls two cheap-to-detect entity shapes used by the
// entity-boost ranker:
//   - PROPER:  sequences of capitalized words
//   - QUOTED:  text inside single or double quotes

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
  // The extraction prompt always leads facts with "User..." — drop it
  // as an entity since it would link to ~every memory and provide zero
  // discriminative signal. Bare month/day names go too; the answerer's
  // prompt-level date arithmetic handles them separately.
  'user', 'assistant',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// Porter-lite: collapses the common English suffixes that BM25 keyword
// matching cares about (plurals, -ing, -ed, -ly). Lossier than a
// proper Porter stemmer on irregular forms; fine for keyword matching.
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
    // Keep the original -ing form alongside the stem so noun uses
    // ("meeting") still match document occurrences without POS tagging.
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
