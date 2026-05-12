import fs from "node:fs/promises";
import { generateText } from "ai";
import { model } from "../llm.js";
import { paths } from "../paths.js";
import {
  defaultFactRanker,
  type FactRanker,
  type MemoryFilters,
  type RankedFact,
} from "../retrieval/embeddings.js";
import { logger } from "../logger.js";

// Single-shot answerer over Kioku's atomic-fact store. The hybrid
// ranker (cosine + BM25 + entity boost) returns top-K facts; we group
// them by date (newest-first) and feed them to the answerer prompt at
// prompts/answer.md. The model emits free text with a
// <mem_thinking>...</mem_thinking> reasoning block which we strip
// before returning.

export interface QueryResult {
  answer: string;
  citations: string[];
}

export interface QueryDeps {
  factRank?: FactRanker;
  topK?: number;
  filters?: MemoryFilters;
}

const DEFAULT_TOP_K = Number.parseInt(process.env.KIOKU_TOP_K ?? "50", 10);

let cachedAnswerPromptTemplate: string | null = null;
async function getAnswerPromptTemplate(): Promise<string> {
  if (cachedAnswerPromptTemplate) return cachedAnswerPromptTemplate;
  cachedAnswerPromptTemplate = await fs.readFile(`${paths.prompts}/answer.md`, "utf8");
  return cachedAnswerPromptTemplate;
}

// Format facts as `--- {date} ---` headers followed by `- {fact}`
// lines, sorted newest-first. Date headers give the answerer a
// scannable temporal layout for "when" / "first/last" questions.
export function formatFactsGroupedByDateNewestFirst(facts: RankedFact[]): string {
  const sorted = [...facts].sort((a, b) => (b.eventDate || "").localeCompare(a.eventDate || ""));
  const lines: string[] = [];
  let currentDate = "";
  for (const f of sorted) {
    const date = f.eventDate || f.createdAt.slice(0, 10);
    if (date !== currentDate) {
      currentDate = date;
      lines.push(`\n--- ${date} ---`);
    }
    lines.push(`- ${f.text}`);
  }
  return lines.join("\n").trim();
}

export function stripMemThinking(text: string): string {
  return text
    .replace(/<mem_thinking>[\s\S]*?<\/mem_thinking>/gi, "")
    .replace(/^[\s:.-]+/, "")
    .trim();
}

// Retrieval-side citations: the deduped set of source sessions the
// hybrid ranker pulled facts from. `consolidate()` writes sessions as
// `raw/${sessionId}` so the prefix is stripped here — external
// consumers (and LongMemEval's `answer_session_ids` ground truth)
// expect the bare id. Order follows the rank order of `facts`, so the
// most-relevant session is first. Empty/missing sourceSession is
// dropped (bot-written facts via appendSingleFact may omit it).
export function extractCitations(facts: RankedFact[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of facts) {
    const id = f.sourceSession.replace(/^raw\//, "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// `today` defaults to the latest fact's event_date, falling back to wall
// clock when the vault is empty. Used as the anchor for the answerer's
// relative-date arithmetic ("last year", "two months ago").
export function deriveQuestionDate(facts: RankedFact[]): string {
  let max = "";
  for (const f of facts) {
    const d = f.eventDate || f.createdAt.slice(0, 10);
    if (d > max) max = d;
  }
  return max || new Date().toISOString().slice(0, 10);
}

export async function query(question: string, deps: QueryDeps = {}): Promise<QueryResult> {
  const k = deps.topK ?? DEFAULT_TOP_K;
  const ranker = deps.factRank ?? defaultFactRanker;

  let facts: RankedFact[] = [];
  try {
    facts = await ranker(question, k, { filters: deps.filters });
  } catch (error) {
    logger.error({ error }, "fact ranker failed");
  }

  const memoriesText =
    facts.length > 0 ? formatFactsGroupedByDateNewestFirst(facts) : "(No relevant memories found)";
  const questionDate = deriveQuestionDate(facts);

  const template = await getAnswerPromptTemplate();
  const prompt = template
    .replace("{question_date}", questionDate)
    .replace("{question_date}", questionDate)
    .replace("{memories}", memoriesText)
    .replace("{question}", question);

  const citations = extractCitations(facts);

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0,
      abortSignal: AbortSignal.timeout(120_000),
    });
    return {
      answer: stripMemThinking(result.text) || "(empty answer)",
      citations,
    };
  } catch (err) {
    return {
      answer: `(no answer — query failed: ${(err as Error).message})`,
      citations,
    };
  }
}
