// Post-extraction relevance filter.
//
// consolidate()'s LLM extraction over-extracts on casual companion-style
// chat: greetings, affection, the assistant's own reactions, and pure
// conversational meta. These are not durable user memories — they inflate
// the store, recur nondeterministically (gpt-4o-mini variance), and dodge
// cosine dedup via verbose date-stamped phrasing. Prompt rules bias the
// mean but don't remove the variance; this is the deterministic clip,
// applied AFTER extraction and BEFORE embed/dedup/append.
//
// Hard design constraint: it must NOT drop task/factual memories, because
// LongMemEval (the retrieval benchmark) is entirely task Q&A and a dropped
// evidence fact is lost recall. The predicate is therefore CONSERVATIVE —
// default KEEP; drop only on a high-precision signature that LongMemEval-
// style facts (trips, jobs, stats, dates, named entities, preferences) do
// not match. tests/relevance.test.ts encodes the benchmark-safety contract
// (a battery of task facts that must all survive); the LongMemEval harness
// verifies it end-to-end (delta vs the no-filter baseline must be ~0).

// Bot persona names whose self-narration ("Shiro responded …") is not a
// user memory. "assistant" always; extra comma-separated aliases via
// KIOKU_ASSISTANT_ALIASES (e.g. "Shiro,Kokoro"). Defaults include "shiro"
// for the current deployment; override to retune without code change.
const ASSISTANT_ALIASES: string[] = [
  "assistant",
  ...(process.env.KIOKU_ASSISTANT_ALIASES ?? "shiro")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

// Aliases are simple identifiers; sanitize rather than regex-escape so
// arbitrary env input can't break (or inject into) the pattern.
const ALIAS = ASSISTANT_ALIASES.filter((a) => /^[a-z0-9 _-]+$/.test(a)).join("|") || "assistant";

// (1) Fact whose subject/actor is the assistant/bot. The extraction prompt
// mandates assistant-origin content be framed user-side ("User was
// recommended X"); a fact that instead leads with the assistant, or has
// the assistant performing a social/affective act, is off-spec narration.
const ASSISTANT_ACTOR = new RegExp(
  `^\\s*(the\\s+)?(${ALIAS})\\b` +
    `|\\b(the\\s+)?(${ALIAS})\\s+(felt|was\\s+(happy|glad|pleased)|expressed|responded|replied|greeted|reminded|noted\\s+that|said\\s+['"])`,
  "i",
);

// (2) Pure social pleasantry — greeting/farewell/affection/etc. Each
// pattern is deliberately narrow so task facts don't match.
const SOCIAL_PLEASANTRY: RegExp[] = [
  /\bgreet(ed|ing|ings|s)\b/i,
  /\bwished\b[^.]*\bgood\s+(morning|night|evening)\b/i,
  /\bmiss(ed|es|ing)?\s+(you|u)\b/i,
  /\bexpress(ed|es|ing)?\s+(affection|missing|appreciation\s+by\s+saying|satisfaction\s+by\s+saying)\b/i,
  /\b(playful|light-?hearted)\s+(exchange|interaction|conversation|response|tone|manner|banter|relationship)\b/i,
  /\bslept\s+well\b/i,
  /\brepeated\s+the\s+name\b/i,
  /\bresponded\s+with\s+['"]?(ok|okay|hi|hey|yep|sure|mhm)\b/i,
  /\bconfirmed\s+(that\s+)?everything\s+(is|was)\s+(good|ok|okay|fine|alright)\b/i,
  /\binquired\s+if\s+the\s+assistant\b/i,
  /\bsaid\s+['"]?good\s+girl\b/i,
];

/** True → drop (low-value / non-durable). Conservative: default keep. */
export function isLowValueFact(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (ASSISTANT_ACTOR.test(t)) return true;
  return SOCIAL_PLEASANTRY.some((re) => re.test(t));
}

/** Partition extracted memories into durable (kept) and low-value (dropped). */
export function filterDurableFacts<T extends { text: string }>(
  mems: T[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const m of mems) (isLowValueFact(m.text) ? dropped : kept).push(m);
  return { kept, dropped };
}
