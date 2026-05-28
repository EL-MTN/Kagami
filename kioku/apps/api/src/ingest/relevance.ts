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

const RELEVANCE_SYSTEM = `You are a strict gatekeeper protecting a personal long-term memory store from conversational noise. Your DEFAULT is KEEP. Drop a statement only when you are certain it carries no durable fact whatsoever.

THE TEST: mentally strip the conversational framing from the statement. If ANYTHING factual remains — a name, place, object, date, event, number, preference, plan, possession, relationship, decision, or substantive information the assistant provided — KEEP the entire statement. Drop ONLY if nothing factual is left.

Framing is NOT grounds to drop. "User is seeking tips on X", "User asked about Y", "User expressed gratitude for Z", "User is excited about W", "User hopes to ..." almost always wrap a durable fact about X/Y/Z/W. Keep them — the framing is harmless; the embedded fact is the point.

KEEP examples (all durable — do NOT drop):
- "User's friends Mike and Emma welcomed their first baby, a girl named Charlotte, in early 2023"
- "User recently finished a Tamiya 1/48 scale Spitfire Mk.V model"
- "User attended their friend Jen's wedding; her husband is Tom"
- "User redeemed credit-card points for a $500 gift card for car accessories"
- "User started using a new laptop backpack that arrived on January 20, 2023"
- "User is seeking advice on painting metal surfaces for model kits" (wraps the model-kit hobby)
- "User expressed gratitude for breakfast spot recommendations in Maui" (wraps the Maui trip)

DROP only statements whose ENTIRE content is conversational with zero embedded fact:
- bare greetings / farewells ("User greeted the assistant", "User said 'Shiro~'")
- standalone affection / pleasantries with no fact ("User said they miss the assistant", "User wished the assistant good morning")
- the assistant's own feelings or social actions ("Assistant felt happy to help", "Assistant greeted the user")
- pure acknowledgements ("User said ok", "User confirmed everything is good")

If in any doubt at all, KEEP. Return the ids of the statements to DROP; omit every id you keep; return an empty list if nothing is purely conversational.`;

const RelevanceResult = z.object({
  drop: z
    .array(z.string())
    .describe("ids of statements that are purely non-durable conversational noise"),
});

interface Candidate {
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
