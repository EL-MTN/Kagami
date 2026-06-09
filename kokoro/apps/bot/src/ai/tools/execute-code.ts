import { tool } from "ai";
import { z } from "zod";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { raisePendingConfirmation } from "./confirmations";
import type { SandboxLanguage } from "../../services/code-sandbox";

/**
 * Schema cap on the code body, chosen so the FULL program always fits in the
 * approval bubble (Telegram caps a message at 4096 chars, and the prompt adds
 * wrapper text + the ≤200-char description). What the user reviews is exactly
 * what executes — never a truncated preview a model could hide a suffix
 * behind. Mirrored by `executeCodeArgs` in gated-actions.ts, which re-enforces
 * it at the dispatch boundary.
 */
export const MAX_CODE_LENGTH = 3000;

function buildCodePrompt(language: SandboxLanguage, code: string, description: string): string {
  const fenceTag = language === "python" ? "python" : "js";
  return [
    `Run this ${language} code in the sandbox?`,
    ``,
    description,
    ``,
    `\`\`\`${fenceTag}`,
    code,
    `\`\`\``,
  ].join("\n");
}

/**
 * Model-facing tool for sandboxed code execution. Like the proposal tools, it
 * does NOT execute anything directly: it raises a tap-to-approve bubble whose
 * `promptText` carries the FULL code in a fenced block — the user reviews the
 * exact program, not a one-line summary — and whose approved action is the
 * dispatch-only `executeCode`. Keeping the action out of `GATED_TOOL_NAMES`
 * means the model can't route around the code display via the generic
 * `requestConfirmation` (whose bubble shows only a ≤400-char summary).
 */
export function createExecuteCodeTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Run a short self-contained Python or Node script in a locked-down sandbox — use it for exact math, data transforms, text processing, or anything better computed than reasoned. The sandbox has NO network, no host filesystem, no installed packages beyond the language's standard library, ~2 minutes of wall clock, and capped output: write a single script that prints its result to stdout. Goshujin-sama gets a tap-to-approve bubble showing the code; it runs only if he approves. Returns immediately with { pending: true } — stop and wait, don't call it again in the same turn.",
    inputSchema: z.object({
      language: z
        .enum(["python", "node"])
        .describe("Interpreter to run the code under (python = CPython 3, node = Node.js)."),
      code: z
        .string()
        .min(1)
        .max(MAX_CODE_LENGTH)
        .describe(
          "The complete script (max 3000 chars), read from stdin by the interpreter. Print results to stdout — that's the only channel back.",
        ),
      description: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "One short sentence on what the code does, shown on the approval prompt. Be specific: 'compute compound interest over 30 years' beats 'run calculation'.",
        ),
    }),
    execute: async ({ language, code, description }) => {
      try {
        const id = await raisePendingConfirmation(chatId, adapter, {
          summary: `run ${language} code: ${description}`,
          action: { tool: "executeCode", args: { language, code } },
          origin: "conversation",
          promptText: buildCodePrompt(language, code, description),
        });

        // Never log the code body — only its shape (see gated-actions.ts).
        logger.debug(
          { confirmationId: id, chatId, language, codeLength: code.length },
          "Tool: executeCode",
        );
        return {
          pending: true,
          confirmationId: id,
          message:
            "Approval prompt sent with the code. Stop here — don't call this again in this turn. Goshujin-sama will tap Approve or Deny.",
        };
      } catch (error) {
        logger.error({ error, chatId }, "Tool: executeCode failed");
        return {
          pending: false,
          success: false,
          reason: error instanceof Error ? error.message : "Failed to create confirmation",
        };
      }
    },
  });
}
