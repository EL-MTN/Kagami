import type { IConversation, IMessage } from "@kokoro/db";

// Serialize a Kokoro conversation into the markdown transcript shape
// Kioku's POST /sessions expects:
//
//   ---
//   id: <session-id>
//   started_at: <ISO timestamp>
//   ---
//
//   ## t-1 user
//   <text>
//
//   ## t-2 assistant
//   <text>
//
// Skips system and tool messages — only user/assistant turns carry
// substance worth extracting facts from. Skips empty messages so the
// transcript stays clean.

const KEEP_ROLES: ReadonlySet<IMessage["role"]> = new Set(["user", "assistant"]);

export function buildTranscript(convo: IConversation): string {
  const startedAt = (convo.createdAt ?? new Date()).toISOString();
  const lines: string[] = ["---", `id: ${convo.sessionId}`, `started_at: ${startedAt}`, "---", ""];

  let turnIndex = 0;
  for (const msg of convo.messages) {
    if (!KEEP_ROLES.has(msg.role)) continue;
    const text = msg.content?.trim();
    if (!text) continue;
    turnIndex += 1;
    lines.push(`## t-${turnIndex} ${msg.role}`);
    lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}

// A conversation only earns an ingest if the *user* contributed something.
// Proactive-only sessions (Mashiro pings, user never replies) would otherwise
// ship to Kioku and have the extractor invent "the assistant offered..." facts
// from a one-sided transcript. The assistant talking to itself is not memory.
export function transcriptHasContent(convo: IConversation): boolean {
  for (const msg of convo.messages) {
    if (msg.role === "user" && msg.content?.trim()) return true;
  }
  return false;
}
