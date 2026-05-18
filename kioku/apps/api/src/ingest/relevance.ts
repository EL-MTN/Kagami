import { z } from "zod";
import { generateObject } from "ai";
import { model } from "../llm.js";
import { logger } from "../logger.js";

// LLM relevance pass. consolidate()'s extraction over-extracts on casual
// companion-style chat: greetings, affection, the assistant's own
// reactions, pure conversational meta. Rather than a brittle deterministic
// heuristic (which mismatched substantive facts on bare keywords), a
// constrained temp-0 binary classifier judges each extracted candidate.
//
// Default KEEP: a candidate is dropped only when the classifier explicitly
// names it non-durable, and ANY classifier failure fails OPEN (keep all) —
// losing a real memory is worse than storing a junk one, and the answerer
// resolves redundancy newest-wins anyway. There is deliberately no static
// unit test of the judgment (an LLM can't be statically proven); benchmark
// neutrality is validated empirically by the LongMemEval battery.

const RELEVANCE_SYSTEM = `You decide which extracted statements are durable long-term user memories worth storing in a personal memory system, versus conversational noise that is not.

KEEP (durable): anything about the user or their world that stays useful weeks later — identity, relationships, preferences, plans, events with dates, possessions, decisions, professional / health / financial details, named entities, and substantive information the assistant provided or researched (recommendations, instructions, looked-up facts). When unsure, KEEP.

DROP (non-durable): greetings and farewells; affection and pleasantries ("miss you", "good morning", terms of endearment); the assistant's own feelings or actions narrated as if they were a memory; and pure descriptions of the exchange itself ("user said ok", "user checked in"). Drop a statement only when its ENTIRE content is one of these — if it also carries a durable fact, KEEP it.

Return the ids of the statements to DROP. Omit the ids you are keeping. If nothing should be dropped, return an empty list.`;

const RelevanceResult = z.object({
  drop: z
    .array(z.string())
    .describe("ids of statements that are purely non-durable conversational noise"),
});

export interface Candidate {
  id: string;
  text: string;
}

// Partition extracted memories into durable (kept) and non-durable
// (dropped) via one batched classifier call. Empty input short-circuits
// without an LLM call; a classifier error keeps everything.
export async function filterDurableFacts<T extends Candidate>(
  mems: T[],
): Promise<{ kept: T[]; dropped: T[] }> {
  if (mems.length === 0) return { kept: [], dropped: [] };

  let dropIds: Set<string>;
  try {
    const { object } = await generateObject({
      model,
      schema: RelevanceResult,
      system: RELEVANCE_SYSTEM,
      prompt: `Statements:\n${mems.map((m) => `[${m.id}] ${m.text}`).join("\n")}\n\nReturn the ids to drop.`,
      temperature: 0,
      abortSignal: AbortSignal.timeout(30_000),
    });
    dropIds = new Set(object.drop);
  } catch (error) {
    logger.warn({ error }, "relevance classifier failed — keeping all candidates");
    return { kept: [...mems], dropped: [] };
  }

  const kept: T[] = [];
  const dropped: T[] = [];
  for (const m of mems) (dropIds.has(m.id) ? dropped : kept).push(m);
  return { kept, dropped };
}
