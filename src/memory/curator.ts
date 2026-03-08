import { generateText, generateObject } from "ai";
import { z } from "zod";
import { format, subDays, subMonths } from "date-fns";
import { getModel, ModelTier } from "../ai/provider.js";
import {
  getOverflowMessages,
  trimConversation,
  type IMessage,
  type IConversation,
} from "../db/models/conversation.js";
import * as engine from "./engine.js";
import { logger } from "../utils/logger.js";

const LLM_TIMEOUT_MS = 120_000; // 2 minutes

const CONTEXT_WINDOW = 40;
const CURATION_BATCH = 40;

// Per-chat mutex to prevent concurrent curation
const curationLocks = new Map<string, Promise<void>>();

function formatToolCall(tc: NonNullable<IMessage["toolCalls"]>[number]): string {
  switch (tc.toolName) {
    case "searchMemory":
      return `searched memories for "${tc.args.query ?? ""}"`;
    case "readMemory":
      return `read ${tc.args.path ?? "a memory file"}`;
    case "rememberFact":
      return `remembered: ${tc.args.content ?? "something"}`;
    case "noteToSelf":
      return `noted: ${tc.args.note ?? "something"}`;
    case "listMemories":
      return `browsed her ${tc.args.type ?? ""} memories`;
    case "curateMemory":
      return "organized her memories";
    case "sendPhoto":
      return `sent a photo: ${tc.args.description ?? ""}`;
    case "checkEmail":
      return "checked Goshujin-sama's email";
    case "manageCalendar":
      return `managed calendar (${tc.args.action ?? "unknown"})`;
    case "manageReminders":
      return `managed reminders (${tc.args.action ?? "unknown"})`;
    default:
      return `used ${tc.toolName}`;
  }
}

function formatMessageForTranscript(m: IMessage): string {
  const role = m.role === "assistant" ? "Mashiro" : m.role;

  // Handle image messages — never include raw image data
  if (m.imageRef) {
    const photoLabel = m.content ? `[sent a photo with caption: "${m.content}"]` : "[sent a photo]";
    return `${role}: ${photoLabel}`;
  }

  // Handle tool call messages
  if (m.role === "assistant" && m.toolCalls?.length) {
    const toolLines = m.toolCalls.map(formatToolCall);
    const parts = [...toolLines];
    if (m.content) parts.push(m.content);
    return parts.map((p) => `Mashiro: ${p}`).join("\n");
  }

  // Skip raw tool results — they're captured via the assistant's tool call descriptions
  if (m.role === "tool") return "";

  return `${role}: ${m.content}`;
}

export async function curateIfNeeded(chatId: string): Promise<void> {
  // Per-chat mutex — skip if curation already in flight for this chat
  const existing = curationLocks.get(chatId);
  if (existing) {
    logger.debug({ chatId }, "Curation already in flight, skipping");
    return;
  }

  const promise = _curateIfNeeded(chatId).finally(() => {
    curationLocks.delete(chatId);
  });
  curationLocks.set(chatId, promise);
  return promise;
}

async function _curateIfNeeded(chatId: string): Promise<void> {
  const overflow = await getOverflowMessages(chatId, CONTEXT_WINDOW);
  if (!overflow) return;

  // Wait for a full batch before curating
  if (overflow.overflow.length < CURATION_BATCH) return;

  logger.info(
    { chatId, overflowCount: overflow.overflow.length, total: overflow.total },
    "Context overflow detected, curating messages",
  );

  const transcript = overflow.overflow.map(formatMessageForTranscript).filter(Boolean).join("\n");

  const { object: curation } = await generateObject({
    model: getModel(),
    schema: z.object({
      summary: z
        .string()
        .describe(
          "Bullet-point summary of the conversation. Include important facts learned, emotional highlights, topics discussed, and any promises or follow-ups. Write from Mashiro's perspective.",
        ),
      emotionalTone: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Overall emotional tone: 1=very negative, 10=very positive"),
      importance: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Importance of this conversation: 1=mundane small talk, 10=life-changing event"),
      followUps: z
        .array(z.string())
        .describe("Action items, promises, or things to follow up on. Empty array if none."),
    }),
    system: `You are a memory curator. Summarize conversations into key points. Be concise. Use bullet points. Write from the perspective of Mashiro (the girlfriend AI) remembering the conversation.`,
    messages: [
      {
        role: "user",
        content: `Summarize this conversation segment:\n\n${transcript}`,
      },
    ],
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  // Store episode in Memory collection
  await engine.remember(curation.summary, "episode", "curation", {
    chatId,
    emotionalTone: curation.emotionalTone,
    importance: curation.importance,
    followUps: curation.followUps,
  });

  // Update facts with bounded retrieval
  await updateUserFacts(curation.summary);

  // Trim conversation to keep only recent messages
  await trimConversation(overflow.conversationId, CONTEXT_WINDOW);

  logger.info(
    { chatId, trimmedTo: CONTEXT_WINDOW },
    "Curation complete: summarized overflow and trimmed conversation",
  );

  // NOTE: Weekly/monthly merges are decoupled — they run on the proactive scheduler only
}

/**
 * Curate a closed session. Triggered when getOrCreateSession detects a stale session.
 * Short sessions get a lightweight summary; longer ones get full curation.
 */
export async function curateClosedSession(conversation: IConversation): Promise<void> {
  const messages = conversation.messages;
  if (messages.length === 0) return;

  const chatId = conversation.chatId;

  // Per-chat mutex
  const existing = curationLocks.get(chatId);
  if (existing) {
    await existing;
  }

  const promise = _curateClosedSession(conversation).finally(() => {
    curationLocks.delete(chatId);
  });
  curationLocks.set(chatId, promise);
  return promise;
}

async function _curateClosedSession(conversation: IConversation): Promise<void> {
  const messages = conversation.messages;
  const chatId = conversation.chatId;

  logger.info(
    { chatId, messageCount: messages.length, sessionId: conversation.sessionId },
    "Curating closed session",
  );

  const transcript = messages.map(formatMessageForTranscript).filter(Boolean).join("\n");

  if (messages.length < 5) {
    // Lightweight summary for short sessions
    await engine.remember(
      `Brief session: ${transcript.slice(0, 500)}`,
      "episode",
      "session-curation",
      {
        chatId,
        importance: 3,
        sessionId: conversation.sessionId,
      },
    );
    logger.info({ chatId, messageCount: messages.length }, "Short session curated (lightweight)");
    return;
  }

  // Full curation for longer sessions
  const { object: curation } = await generateObject({
    model: getModel(),
    schema: z.object({
      summary: z
        .string()
        .describe(
          "Bullet-point summary of the conversation. Include important facts, emotional highlights, topics, and follow-ups. Write from Mashiro's perspective.",
        ),
      emotionalTone: z.number().int().min(1).max(10),
      importance: z.number().int().min(1).max(10),
      followUps: z.array(z.string()),
    }),
    system: `You are a memory curator. Summarize conversations into key points. Be concise. Use bullet points. Write from the perspective of Mashiro (the girlfriend AI) remembering the conversation.`,
    messages: [
      {
        role: "user",
        content: `Summarize this conversation session:\n\n${transcript}`,
      },
    ],
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  await engine.remember(curation.summary, "episode", "session-curation", {
    chatId,
    emotionalTone: curation.emotionalTone,
    importance: curation.importance,
    followUps: curation.followUps,
    sessionId: conversation.sessionId,
  });

  await updateUserFacts(curation.summary);

  logger.info(
    { chatId, messageCount: messages.length, sessionId: conversation.sessionId },
    "Closed session fully curated",
  );
}

const FactOperationSchema = z.object({
  operations: z.array(
    z.object({
      action: z.enum(["ADD", "UPDATE", "DELETE", "NOOP"]),
      content: z.string().describe("The fact content"),
      existingId: z.string().optional().describe("ID of the existing fact to update or delete"),
    }),
  ),
});

async function updateUserFacts(summary: string): Promise<void> {
  // Bounded: only fetch the 30 most relevant facts for classification
  const relevantFacts = await engine.getFactsByRelevance(summary, 30);
  const totalFacts = await engine.getFactCount();

  const factsContext =
    relevantFacts.length > 0
      ? relevantFacts.map((f) => `[id:${f._id}] ${f.content}`).join("\n")
      : "(no existing facts)";

  const totalNote =
    totalFacts > relevantFacts.length
      ? `\n\nNote: Showing ${relevantFacts.length} most relevant facts out of ${totalFacts} total. Only classify against facts shown above.`
      : "";

  const { object: result } = await generateObject({
    model: getModel(ModelTier.Fast),
    schema: FactOperationSchema,
    system: `You are a memory curator. Given a conversation summary and a list of existing facts about the user, classify what changes need to be made.

For each relevant fact from the conversation, output an operation:
- ADD: new fact not covered by any existing fact
- UPDATE: an existing fact needs correction or updating (include existingId)
- DELETE: an existing fact is now known to be wrong or outdated (include existingId)
- NOOP: fact already exists and is current (skip these)

If there are no changes needed, output an empty operations array.`,
    messages: [
      {
        role: "user",
        content: `Existing facts:\n${factsContext}${totalNote}\n\nConversation summary:\n${summary}`,
      },
    ],
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  const operations = result.operations;

  if (operations.length === 0) {
    logger.debug("No fact operations needed");
    return;
  }

  let added = 0;
  let updated = 0;
  let deleted = 0;

  for (const op of operations) {
    switch (op.action) {
      case "ADD":
        await engine.remember(op.content, "fact", "curation");
        added++;
        break;
      case "UPDATE":
        if (op.existingId) {
          await engine.forget(op.existingId);
        }
        await engine.remember(op.content, "fact", "curation");
        updated++;
        break;
      case "DELETE":
        if (op.existingId) {
          await engine.forget(op.existingId);
          deleted++;
        }
        break;
    }
  }

  logger.info({ added, updated, deleted }, "Fact operations applied");
}

// In-flight guards to prevent concurrent consolidation runs
let weeklyMergeInFlight: Promise<void> | null = null;
let monthlyConsolidationInFlight: Promise<void> | null = null;

export function checkWeeklyMerge(): Promise<void> {
  if (weeklyMergeInFlight) return weeklyMergeInFlight;
  weeklyMergeInFlight = _checkWeeklyMerge().finally(() => {
    weeklyMergeInFlight = null;
  });
  return weeklyMergeInFlight;
}

async function _checkWeeklyMerge(): Promise<void> {
  const oneWeekAgo = subDays(new Date(), 7);
  const oldEpisodes = await engine.getEpisodesBefore(oneWeekAgo, ["weekly-merge"]);

  if (oldEpisodes.length >= 4) {
    logger.info({ episodeCount: oldEpisodes.length }, "Triggering weekly merge");
    await weeklyDeepCuration(oldEpisodes);
  }
}

async function weeklyDeepCuration(
  episodes: Awaited<ReturnType<typeof engine.getEpisodesBefore>>,
): Promise<void> {
  if (episodes.length === 0) return;

  const contents = episodes.map(
    (ep) => `## ${format(ep.metadata.createdAt, "yyyy-MM-dd")}\n${ep.content}`,
  );

  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Compress multiple daily summaries into a single weekly summary. Keep the most important facts, memorable moments, and evolving patterns. Remove redundancy. Write from Mashiro's perspective.`,
    messages: [
      {
        role: "user",
        content: `Compress these daily summaries:\n\n${contents.join("\n\n")}`,
      },
    ],
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  // Store weekly summary
  const merged = await engine.remember(result.text, "episode", "weekly-merge", { importance: 6 });

  // Non-destructive archival (replaces sequential forget)
  const ids = episodes.map((ep) => ep._id.toString());
  await engine.archiveMany(ids, merged._id.toString());

  const weekOf = format(subDays(new Date(), 7), "yyyy-MM-dd");
  logger.info({ weekOf, mergedEpisodes: episodes.length }, "Weekly curation complete");
}

export function checkMonthlyConsolidation(): Promise<void> {
  if (monthlyConsolidationInFlight) return monthlyConsolidationInFlight;
  monthlyConsolidationInFlight = _checkMonthlyConsolidation().finally(() => {
    monthlyConsolidationInFlight = null;
  });
  return monthlyConsolidationInFlight;
}

async function _checkMonthlyConsolidation(): Promise<void> {
  const oneMonthAgo = subMonths(new Date(), 1);
  const oldWeeklyEpisodes = await engine.getEpisodesBefore(oneMonthAgo);
  const weeklyMerges = oldWeeklyEpisodes.filter((ep) => ep.source === "weekly-merge");

  if (weeklyMerges.length >= 3) {
    logger.info({ episodeCount: weeklyMerges.length }, "Triggering monthly consolidation");
    await monthlyDeepConsolidation(weeklyMerges);
  }
}

async function monthlyDeepConsolidation(
  episodes: Awaited<ReturnType<typeof engine.getEpisodesBefore>>,
): Promise<void> {
  if (episodes.length === 0) return;

  const contents = episodes.map(
    (ep) => `## ${format(ep.metadata.createdAt, "yyyy-MM-dd")}\n${ep.content}`,
  );

  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Compress multiple weekly summaries into a single monthly summary focused on relationship patterns and long-term observations.

Extract:
1. Recurring themes and topics
2. How the relationship dynamic evolved over the month
3. Key emotional patterns (what makes him happy, what worries him)
4. Important milestones or turning points
5. Long-term observations about his personality and preferences

Write from Mashiro's perspective as long-term relationship insights, not a chronological recap.`,
    messages: [
      {
        role: "user",
        content: `Consolidate these weekly summaries into monthly relationship insights:\n\n${contents.join("\n\n")}`,
      },
    ],
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  // Store as milestone
  const monthOf = format(subMonths(new Date(), 1), "yyyy-MM");
  const merged = await engine.remember(result.text, "milestone", "monthly-consolidation", {
    importance: 7,
  });

  // Non-destructive archival
  const ids = episodes.map((ep) => ep._id.toString());
  await engine.archiveMany(ids, merged._id.toString());

  logger.info({ monthOf, mergedEpisodes: episodes.length }, "Monthly consolidation complete");
}
