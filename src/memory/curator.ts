import { generateText, generateObject } from "ai";
import { z } from "zod";
import { format, subDays, subMonths } from "date-fns";
import { getModel, ModelTier } from "../ai/provider.js";
import { getOverflowMessages, trimConversation, type IMessage } from "../db/models/conversation.js";
import { writeVaultFile } from "./vault.js";
import * as engine from "./engine.js";
import { logger } from "../utils/logger.js";

const LLM_TIMEOUT_MS = 120_000; // 2 minutes

const CONTEXT_WINDOW = 40;
const CURATION_BATCH = 40;

function formatToolCall(tc: NonNullable<IMessage["toolCalls"]>[number]): string {
  switch (tc.toolName) {
    case "searchMemory":
      return `searched memories for "${tc.args.query ?? ""}"`;
    case "readMemory":
      return `read ${tc.args.path ?? "a memory file"}`;
    case "writeMemory":
      return `wrote to ${tc.args.path ?? "a memory file"}`;
    case "listMemories":
      return `browsed her ${tc.args.type ?? ""} memories`;
    case "curateMemory":
      return "organized her memories";
    case "sendPhoto":
      return `sent a photo: ${tc.args.description ?? ""}`;
    default:
      return `used ${tc.toolName}`;
  }
}

function formatMessageForTranscript(m: IMessage): string {
  const role = m.role === "assistant" ? "Mashiro" : m.role;

  // Handle image messages — never include base64
  if (m.imageBase64) {
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
  const overflow = await getOverflowMessages(chatId, CONTEXT_WINDOW);
  if (!overflow) return;

  // Wait for a full batch before curating — avoids wasting LLM calls
  // on tiny 1-5 message summaries. The AI only sees the last CONTEXT_WINDOW
  // messages via assembleMessages, so the unsummarized overflow is harmless.
  if (overflow.overflow.length < CURATION_BATCH) return;

  logger.info(
    { chatId, overflowCount: overflow.overflow.length, total: overflow.total },
    "Context overflow detected, curating messages",
  );

  // Format overflow as rich transcript
  const transcript = overflow.overflow.map(formatMessageForTranscript).filter(Boolean).join("\n");

  // Summarize overflow with structured metadata extraction
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

  const summary = curation.summary;
  const metadata: CurationMetadata = {
    emotionalTone: curation.emotionalTone,
    importance: curation.importance,
    followUps: curation.followUps,
  };

  // Store episode in Memory collection (single source of truth for conversations)
  await engine.remember(summary, "episode", "curation", {
    chatId,
    emotionalTone: metadata.emotionalTone,
    importance: metadata.importance,
    followUps: metadata.followUps,
  });

  // Update about-you.md with ADD/UPDATE/DELETE fact management
  await updateUserFacts(summary);

  // Trim conversation to keep only recent messages
  await trimConversation(overflow.conversationId, CONTEXT_WINDOW);

  logger.info(
    { chatId, trimmedTo: CONTEXT_WINDOW },
    "Curation complete: summarized overflow and trimmed conversation",
  );

  // Check if weekly merge is due, then monthly consolidation
  await checkWeeklyMerge();
  await checkMonthlyConsolidation();
}

interface CurationMetadata {
  emotionalTone: number;
  importance: number;
  followUps: string[];
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
  const existingFacts = await engine.getAllFacts();

  const factsContext =
    existingFacts.length > 0
      ? existingFacts.map((f) => `[id:${f._id}] ${f.content}`).join("\n")
      : "(no existing facts)";

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
        content: `Existing facts:\n${factsContext}\n\nConversation summary:\n${summary}`,
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

  // Regenerate about-you.md from all current facts
  await regenerateAboutYou();
}

async function regenerateAboutYou(): Promise<void> {
  const allFacts = await engine.getAllFacts();
  if (allFacts.length === 0) return;

  const content = allFacts.map((f) => `- ${f.content}`).join("\n");
  await writeVaultFile("memories/about-you.md", content, {
    type: "user-facts",
    factCount: allFacts.length,
    lastUpdated: new Date().toISOString(),
  });
  logger.info({ factCount: allFacts.length }, "Regenerated about-you.md from Memory collection");
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
  // Find curation episodes older than 7 days (exclude weekly-merge rollups)
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

  // Store weekly summary as a new episode in MongoDB
  await engine.remember(result.text, "episode", "weekly-merge", { importance: 6 });

  // Delete merged daily episodes to prevent re-merging
  for (const ep of episodes) {
    await engine.forget(ep._id.toString()).catch((error) => {
      logger.warn({ error, episodeId: ep._id }, "Failed to delete merged episode");
    });
  }

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
  // Find weekly-merge episodes older than 30 days
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

  // Store full text as milestone in MongoDB (no truncation needed)
  const monthOf = format(subMonths(new Date(), 1), "yyyy-MM");
  await engine.remember(result.text, "milestone", "monthly-consolidation", { importance: 7 });

  // Delete merged weekly episodes
  for (const ep of episodes) {
    await engine.forget(ep._id.toString()).catch((error) => {
      logger.warn({ error, episodeId: ep._id }, "Failed to delete merged weekly episode");
    });
  }

  logger.info({ monthOf, mergedEpisodes: episodes.length }, "Monthly consolidation complete");
}
