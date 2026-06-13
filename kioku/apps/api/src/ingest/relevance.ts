import { z } from "zod";
import { generateObject } from "ai";
import { model } from "../llm.js";
import { logger } from "../logger.js";

// LLM relevance pass. consolidate()'s extraction over-extracts on casual
// companion-style chat: greetings, affection, the assistant's own
// reactions, the mechanics of getting things done in chat, transient
// lookups (weather, prices, "what's on this weekend"), and superseded
// states. Rather than a brittle deterministic heuristic (which mismatched
// substantive facts on bare keywords), a constrained temp-0 classifier
// judges each extracted candidate against the durability test — the same
// test the consolidation pass (prompts/consolidate.md) applies, so ingest
// and periodic consolidation share one notion of "durable".
//
// Default KEEP: a candidate is dropped only when the classifier explicitly
// names it non-durable, and ANY classifier failure fails OPEN (keep all) —
// losing a real memory is worse than storing a junk one (consolidation is
// the safety net that catches what slips past), and the answerer resolves
// redundancy newest-wins anyway. There is deliberately no static unit test
// of the judgment (an LLM can't be statically proven); benchmark neutrality
// is validated empirically by the LongMemEval battery.

const RELEVANCE_SYSTEM = `You are a strict gatekeeper protecting a personal long-term memory store from conversational noise. The store holds DURABLE facts about the user and their world — things that still matter weeks later, independent of the conversation they came from. Your DEFAULT is KEEP: drop a statement only when you are certain it carries no durable fact.

THE TEST: mentally strip the conversational framing, then ask — would what remains still matter to the user a month from now, on its own? If ANY durable fact remains — a name, place, possession, relationship, preference, plan, decision, an event that actually happened, an identifier, or a stable attribute — KEEP the entire statement. Drop ONLY when nothing durable is left.

Framing is NOT grounds to drop. "User is seeking tips on X", "User asked about Y", "User expressed gratitude for Z", "User is excited about W", "User hopes to ..." almost always wrap a durable fact about X/Y/Z/W. Keep them — the framing is harmless; the embedded fact is the point.

KEEP examples (all durable — do NOT drop):
- "User's friends Mike and Emma welcomed their first baby, a girl named Charlotte, in early 2023"
- "User recently finished a Tamiya 1/48 scale Spitfire Mk.V model"
- "User attended their friend Jen's wedding; her husband is Tom"
- "User redeemed credit-card points for a $500 gift card for car accessories"
- "User started using a new laptop backpack that arrived on January 20, 2023"
- "User is seeking advice on painting metal surfaces for model kits" (wraps the model-kit hobby)
- "User expressed gratitude for breakfast spot recommendations in Maui" (wraps the Maui trip)

DROP statements whose durable content, once the framing is stripped, is nothing — conversational exhaust:
- bare greetings / farewells ("User greeted the assistant", "User said 'Shiro~'")
- standalone affection / pleasantries with no fact ("User said they miss the assistant", "User wished the assistant good morning")
- the assistant's own feelings or social actions ("Assistant felt happy to help", "Assistant greeted the user")
- pure acknowledgements ("User said ok", "User confirmed everything is good")
- conversation mechanics with no content ("User repeated the request for clarity", "User checked the assistant's last message", "User checked the time and was told it was 6:45 PM", "User asked the assistant for a selfie")
- the assistant's own tool/capability/connection state ("the assistant's email tool only returns unread messages", "User learned the assistant has tools for email, calendar, and reminders", "User was informed the email connection wasn't set up yet")
- the mechanics of getting something done in chat — a request, approval, retry, or "done" with no lasting residue ("User asked the assistant to send the email", "User approved the draft", "User confirmed the message was sent"). The act of sending or running something is not a fact about the user. But keep the durable RESULT it leaves behind: "User's contact Wang Haoqi uses wanghaoqi@vastai3d.com" stays.
- transient lookups whose value has already expired — today's weather, the current time, a live stock price, "events this weekend", a news or market roundup, "what's happening on June 12". The user looked it up; it does not persist. But keep a durable preference the lookup reveals: "User follows SpaceX news" is durable even though "SpaceX was valued at $350B as of today" is not.
- transient or superseded states — "currently on the login page", "the routine is waiting for login", a setting or plan that was immediately changed. Keep only a final state, and only if it is itself durable.

If in any doubt at all, KEEP. Return the ids of the statements to DROP; omit every id you keep; return an empty list if nothing is non-durable.`;

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
