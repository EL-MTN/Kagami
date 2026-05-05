// Convert a Claude Code session jsonl to our transcript format.
// Usage:
//   tsx scripts/cc-to-transcript.ts <session.jsonl> <out.md> [--max-turns N] [--char-cap N]
//
// Filters to user + assistant text turns, drops thinking, tool_use, tool_result,
// system reminders, and attachments.

import fs from "node:fs";
import path from "node:path";

interface Args {
  in: string;
  out: string;
  maxTurns: number;
  charCap: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const [inPath, outPath] = [a[0], a[1]];
  if (!inPath || !outPath) {
    console.error(
      "usage: tsx scripts/cc-to-transcript.ts <session.jsonl> <out.md> [--max-turns N] [--char-cap N]",
    );
    process.exit(1);
  }
  const maxTurnsIdx = a.indexOf("--max-turns");
  const charCapIdx = a.indexOf("--char-cap");
  return {
    in: inPath,
    out: outPath,
    maxTurns: maxTurnsIdx >= 0 ? Number(a[maxTurnsIdx + 1]) : 25,
    charCap: charCapIdx >= 0 ? Number(a[charCapIdx + 1]) : 1200,
  };
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object" && (b as { type: string }).type === "text") {
        return (b as { text: string }).text;
      }
      // skip thinking, tool_use, tool_result, image
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function isSystemNoise(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<system-reminder>") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("Caveat:") ||
    trimmed.startsWith("<local-command-stdout>")
  );
}

function loadTurns(file: string): Turn[] {
  const turns: Turn[] = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let evt: { type?: string; message?: { content?: unknown }; timestamp?: string };
    try {
      evt = JSON.parse(line) as typeof evt;
    } catch {
      continue;
    }
    if (evt.type !== "user" && evt.type !== "assistant") continue;
    const text = extractText(evt.message?.content).trim();
    if (!text) continue;
    if (isSystemNoise(text)) continue;
    turns.push({
      role: evt.type,
      text,
      timestamp: evt.timestamp ?? "",
    });
  }
  return turns;
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap).trimEnd() + "\n\n[…truncated…]";
}

function render(turns: Turn[], id: string, startedAt: string, charCap: number): string {
  const lines: string[] = [
    "---",
    `id: ${id}`,
    `started_at: ${startedAt}`,
    "participants: [user, assistant]",
    "---",
    "",
  ];
  turns.forEach((t, i) => {
    const seq = String(i + 1).padStart(4, "0");
    lines.push(`## t-${seq} ${t.role}`);
    lines.push(clip(t.text, charCap));
    lines.push("");
  });
  return lines.join("\n");
}

const args = parseArgs();
const allTurns = loadTurns(args.in);
const turns = allTurns.slice(0, args.maxTurns);
const id = path
  .basename(args.in, ".jsonl")
  .replace(/[^a-zA-Z0-9-]/g, "-")
  .slice(0, 64);
const startedAt = turns[0]?.timestamp || new Date().toISOString();
const out = render(turns, `cc-${id}`, startedAt, args.charCap);
fs.writeFileSync(args.out, out);
console.log(`wrote ${args.out}: ${turns.length}/${allTurns.length} turns, ${out.length} chars`);
