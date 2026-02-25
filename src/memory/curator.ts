import { generateText } from "ai";
import { format, subDays, subMonths } from "date-fns";
import { getModel, ModelTier } from "../ai/provider.js";
import { getOverflowMessages, trimConversation, type IMessage } from "../db/models/conversation.js";
import { readVaultFile, writeVaultFile, listVaultFiles, deleteVaultFile } from "./vault.js";
import * as engine from "./engine.js";
import { logger } from "../utils/logger.js";

const CONTEXT_LIMIT = 40;
const DEBOUNCE_THRESHOLD = 5;

// Track last curation message count per chat for debouncing
const lastCurationCount = new Map<string, number>();

function formatToolCall(tc: NonNullable<IMessage["toolCalls"]>[number]): string {
  switch (tc.toolName) {
    case "searchMemory":
      return `Mashiro searched memories for "${tc.args.query ?? ""}"`;
    case "readMemory":
      return `Mashiro read ${tc.args.path ?? "a memory file"}`;
    case "writeMemory":
      return `Mashiro wrote to ${tc.args.path ?? "a memory file"}`;
    case "listMemories":
      return `Mashiro browsed her ${tc.args.type ?? ""} memories`;
    case "curateMemory":
      return "Mashiro organized her memories";
    case "sendPhoto":
      return `Mashiro sent a photo: ${tc.args.description ?? ""}`;
    default:
      return `Mashiro used ${tc.toolName}`;
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
  const overflow = await getOverflowMessages(chatId, CONTEXT_LIMIT);
  if (!overflow) return;

  // Debounce: after first curation, wait until 5+ messages overflow
  const lastCount = lastCurationCount.get(chatId) ?? 0;
  if (lastCount > 0 && overflow.overflow.length < DEBOUNCE_THRESHOLD) {
    logger.debug(
      { chatId, overflowCount: overflow.overflow.length, threshold: DEBOUNCE_THRESHOLD },
      "Skipping curation — below debounce threshold",
    );
    return;
  }

  logger.info(
    { chatId, overflowCount: overflow.overflow.length, total: overflow.total },
    "Context overflow detected, curating messages",
  );

  // Format overflow as rich transcript
  const transcript = overflow.overflow.map(formatMessageForTranscript).filter(Boolean).join("\n");

  // Summarize overflow with structured metadata extraction
  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Summarize conversations into key points. Extract:
1. Important facts learned about the user
2. Emotional highlights (good moments, concerns)
3. Topics discussed
4. Any promises, plans, or follow-ups mentioned

Be concise. Use bullet points. Write from the perspective of Mashiro (the girlfriend AI) remembering the conversation.

After the summary, output a YAML metadata block on its own line starting with "---METADATA---":
---METADATA---
emotionalTone: <1-10, where 1=very negative, 10=very positive>
importance: <1-10, where 10=life-changing event>
followUps: ["<action item 1>", "<action item 2>"]
---END---

Always include the metadata block, even if followUps is empty.`,
    messages: [
      {
        role: "user",
        content: `Summarize this conversation segment:\n\n${transcript}`,
      },
    ],
  });

  // Parse metadata from response
  const { summary, metadata } = parseCurationResponse(result.text);

  // Write summary to vault with structured frontmatter
  const timestamp = format(new Date(), "yyyy-MM-dd'T'HH-mm-ss");
  const summaryPath = `memories/conversations/${timestamp}.md`;
  await writeVaultFile(summaryPath, summary, {
    type: "conversation-summary",
    chatId,
    messageCount: overflow.overflow.length,
    timestamp: new Date().toISOString(),
    emotionalTone: metadata.emotionalTone,
    importance: metadata.importance,
    followUps: metadata.followUps,
  });

  // Dual-write: store episode in Memory collection
  await engine.remember(summary, "episode", "curation", {
    chatId,
    emotionalTone: metadata.emotionalTone,
    importance: metadata.importance,
    followUps: metadata.followUps,
    vaultPath: summaryPath,
  });

  // Update about-you.md with ADD/UPDATE/DELETE fact management
  await updateUserFacts(summary);

  // Trim conversation to keep only recent messages
  await trimConversation(overflow.conversationId, CONTEXT_LIMIT);

  // Track for debouncing
  lastCurationCount.set(chatId, overflow.overflow.length);

  logger.info(
    { summaryPath, trimmedTo: CONTEXT_LIMIT },
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

function parseCurationResponse(text: string): { summary: string; metadata: CurationMetadata } {
  const defaults: CurationMetadata = { emotionalTone: 5, importance: 5, followUps: [] };

  const metadataMatch = text.match(/---METADATA---\s*([\s\S]*?)\s*---END---/);
  if (!metadataMatch) {
    return { summary: text.trim(), metadata: defaults };
  }

  const summary = text.slice(0, text.indexOf("---METADATA---")).trim();
  const metaBlock = metadataMatch[1];

  const toneMatch = metaBlock.match(/emotionalTone:\s*(\d+)/);
  const importanceMatch = metaBlock.match(/importance:\s*(\d+)/);
  const followUpsMatch = metaBlock.match(/followUps:\s*\[(.*?)\]/s);

  const emotionalTone = toneMatch ? Math.min(10, Math.max(1, parseInt(toneMatch[1]))) : 5;
  const importance = importanceMatch ? Math.min(10, Math.max(1, parseInt(importanceMatch[1]))) : 5;

  let followUps: string[] = [];
  if (followUpsMatch) {
    followUps = followUpsMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  return { summary, metadata: { emotionalTone, importance, followUps } };
}

interface FactOperation {
  action: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  content: string;
  existingId?: string;
}

async function updateUserFacts(summary: string): Promise<void> {
  const existingFacts = await engine.getAllFacts();

  const factsContext =
    existingFacts.length > 0
      ? existingFacts.map((f) => `[id:${f._id}] ${f.content}`).join("\n")
      : "(no existing facts)";

  const result = await generateText({
    model: getModel(ModelTier.Fast),
    system: `You are a memory curator. Given a conversation summary and a list of existing facts about the user, classify what changes need to be made.

For each relevant fact from the conversation, output a JSON operation:
- ADD: new fact not covered by any existing fact
- UPDATE: an existing fact needs correction or updating (include existingId)
- DELETE: an existing fact is now known to be wrong or outdated (include existingId)
- NOOP: fact already exists and is current (skip these)

Output ONLY a JSON array of operations. No commentary. Example:
[
  {"action": "ADD", "content": "Works as a software engineer at TechCorp"},
  {"action": "UPDATE", "content": "Now lives in Tokyo (moved from Osaka)", "existingId": "abc123"},
  {"action": "DELETE", "content": "No longer at previous job", "existingId": "def456"}
]

If there are no changes needed, output: []`,
    messages: [
      {
        role: "user",
        content: `Existing facts:\n${factsContext}\n\nConversation summary:\n${summary}`,
      },
    ],
  });

  let operations: FactOperation[];
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    operations = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    logger.warn({ response: result.text.slice(0, 200) }, "Failed to parse fact operations");
    return;
  }

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

export async function checkWeeklyMerge(): Promise<void> {
  const files = await listVaultFiles("memories/conversations");
  const oneWeekAgo = format(subDays(new Date(), 7), "yyyy-MM-dd");

  // Find daily summary files (not weekly/monthly rollups) older than 7 days
  const oldDailyFiles = files.filter((f) => {
    if (f.includes("week-of-") || f.includes("month-of-")) return false;
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
    return dateMatch && dateMatch[1] < oneWeekAgo;
  });

  if (oldDailyFiles.length >= 4) {
    logger.info({ fileCount: oldDailyFiles.length }, "Triggering weekly merge");
    await weeklyDeepCuration(oldDailyFiles);
  }
}

async function weeklyDeepCuration(oldFiles: string[]): Promise<void> {
  const contents: string[] = [];
  for (const file of oldFiles) {
    const data = await readVaultFile(file);
    if (data) contents.push(`## ${file}\n${data.content}`);
  }

  if (contents.length === 0) return;

  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Compress multiple daily summaries into a single weekly summary. Keep the most important facts, memorable moments, and evolving patterns. Remove redundancy. Write from Mashiro's perspective.`,
    messages: [
      {
        role: "user",
        content: `Compress these daily summaries:\n\n${contents.join("\n\n")}`,
      },
    ],
  });

  const weekOf = format(subDays(new Date(), 7), "yyyy-MM-dd");
  await writeVaultFile(`memories/conversations/week-of-${weekOf}.md`, result.text, {
    type: "weekly-summary",
    weekOf,
  });

  // Delete merged daily files to prevent re-merging
  for (const file of oldFiles) {
    await deleteVaultFile(file).catch((error) => {
      logger.warn({ error, file }, "Failed to delete merged daily file");
    });
  }

  logger.info({ weekOf, mergedFiles: oldFiles.length }, "Weekly curation complete");
}

export async function checkMonthlyConsolidation(): Promise<void> {
  const files = await listVaultFiles("memories/conversations");
  const oneMonthAgo = format(subMonths(new Date(), 1), "yyyy-MM-dd");

  // Find weekly summaries older than 30 days
  const oldWeeklyFiles = files.filter((f) => {
    if (!f.includes("week-of-")) return false;
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
    return dateMatch && dateMatch[1] < oneMonthAgo;
  });

  if (oldWeeklyFiles.length >= 3) {
    logger.info({ fileCount: oldWeeklyFiles.length }, "Triggering monthly consolidation");
    await monthlyDeepConsolidation(oldWeeklyFiles);
  }
}

async function monthlyDeepConsolidation(oldFiles: string[]): Promise<void> {
  const contents: string[] = [];
  for (const file of oldFiles) {
    const data = await readVaultFile(file);
    if (data) contents.push(`## ${file}\n${data.content}`);
  }

  if (contents.length === 0) return;

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
  });

  const monthOf = format(subMonths(new Date(), 1), "yyyy-MM");
  const monthPath = `memories/conversations/month-of-${monthOf}.md`;

  await writeVaultFile(monthPath, result.text, {
    type: "monthly-summary",
    monthOf,
    mergedWeeklyFiles: oldFiles.length,
  });

  // Store as milestone in Memory collection for long-term retrieval
  await engine.remember(result.text, "milestone", "monthly-consolidation", {
    vaultPath: monthPath,
    importance: 7,
  });

  // Delete merged weekly files
  for (const file of oldFiles) {
    await deleteVaultFile(file).catch((error) => {
      logger.warn({ error, file }, "Failed to delete merged weekly file");
    });
  }

  logger.info({ monthOf, mergedFiles: oldFiles.length }, "Monthly consolidation complete");
}
