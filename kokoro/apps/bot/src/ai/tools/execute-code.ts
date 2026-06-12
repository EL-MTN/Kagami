import { tool } from "ai";
import { z } from "zod";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { raisePendingConfirmation } from "./confirmations";
import type { SandboxLanguage } from "../../services/code-sandbox";
import { OWNER } from "../persona";

/**
 * Schema cap on the code body, chosen so the FULL program always fits in the
 * approval bubble (Telegram caps a message at 4096 chars, and the prompt adds
 * wrapper text + the ≤200-char description). What the user reviews is exactly
 * what executes — never a truncated preview a model could hide a suffix
 * behind. Mirrored by `executeCodeArgs` in gated-actions.ts, which re-enforces
 * it at the dispatch boundary.
 */
const MAX_CODE_LENGTH = 3000;

/**
 * Telegram caps a message at 4096 chars, and the prompt's fence grows with
 * the longest backtick run in the code (see buildCodePrompt) — so a
 * backtick-heavy script can outgrow the bubble even under MAX_CODE_LENGTH.
 * Checked pre-raise: refusing here costs one tool-error turn; raising and
 * failing the send would orphan a pending row the user never saw.
 */
const MAX_PROMPT_LENGTH = 4096;

/**
 * The model-supplied description sits ABOVE the code fence in the same
 * bubble. A backtick run inside it could pair with the code block's fence in
 * the Telegram formatter, breaking the program out of its <pre> block and
 * re-exposing it to the inline markdown passes — the user would review a
 * mangled rendering while the original code still executes. Descriptions are
 * prose; they never need backticks, so replace them outright.
 */
function sanitizeDescription(description: string): string {
  return description.replace(/`/g, "'");
}

function buildCodePrompt(
  language: SandboxLanguage,
  code: string,
  description: string,
  useWorkspace: boolean,
): string {
  const fenceTag = language === "python" ? "python" : "js";
  // The fence must be LONGER than any backtick run inside the code — an
  // embedded ``` would otherwise close the block early and the bubble would
  // show a broken fragment while the pending action still executes the full
  // original code. The Telegram formatter parses fences of 3+ backticks with
  // a matching-length closer, so a longer fence keeps the block byte-exact.
  const longestBacktickRun =
    code.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [
    // Workspace access changes what the user is approving (the run can read
    // and rewrite their files), so it's stated on the bubble's first line.
    `Run this ${language} code in the sandbox${useWorkspace ? " — with workspace access (/workspace mounted read-write)" : ""}?`,
    ``,
    description,
    ``,
    `${fence}${fenceTag}`,
    code,
    fence,
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
    description: `Run a short self-contained Python or Node script in a locked-down sandbox — use it for exact math, data transforms, text processing, or anything better computed than reasoned. The sandbox has NO network, no installed packages beyond the language's standard library, ~2 minutes of wall clock, and capped output: write a single script that prints its result to stdout. Set useWorkspace: true to mount the persistent workspace read-write at /workspace — the run can then read existing files (e.g. inbox/data.csv) and any files it writes there are saved back to the workspace after it finishes (this is how to produce results bigger than stdout, like a CSV or chart to sendFile later). ${OWNER} gets a tap-to-approve bubble showing the code; it runs only if he approves. Returns immediately with { pending: true } — stop and wait, don't call it again in the same turn.`,
    inputSchema: z.object({
      language: z
        .enum(["python", "node"])
        .describe("Interpreter to run the code under (python = CPython 3, node = Node.js)."),
      code: z
        .string()
        .min(1)
        .max(MAX_CODE_LENGTH)
        // The Telegram formatter strips NUL bytes before rendering (they
        // could forge its internal park/restore placeholders), so code
        // containing a NUL would DISPLAY without it while EXECUTING with it.
        // Unicode bidi controls (RLO/LRO, the isolates, PDF…) are worse:
        // Telegram renders them, visually REORDERING the program inside the
        // <pre> bubble while the sandbox receives the original byte order —
        // Trojan-Source style. Both are the displayed≠executed gap this tool
        // must never allow. Mirrored at the dispatch boundary
        // (executeCodeArgs in gated-actions.ts).
        .refine((value) => !value.includes("\u0000") && !/\p{Bidi_Control}/u.test(value), {
          message: "code must not contain NUL or bidirectional-control characters",
        })
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
      useWorkspace: z
        .boolean()
        .optional()
        .describe(
          "Mount the persistent workspace read-write at /workspace. The run sees every workspace file; files it writes/changes/deletes under /workspace are synced back afterward. Leave unset for pure computation.",
        ),
    }),
    execute: async ({ language, code, description, useWorkspace }) => {
      const safeDescription = sanitizeDescription(description);
      const promptText = buildCodePrompt(language, code, safeDescription, useWorkspace ?? false);
      if (promptText.length > MAX_PROMPT_LENGTH) {
        return {
          pending: false,
          success: false,
          reason:
            "the code's long backtick runs make the approval prompt exceed the message size cap — build long backtick strings programmatically (e.g. '`' * n) instead of writing them literally",
        };
      }

      try {
        const id = await raisePendingConfirmation(chatId, adapter, {
          summary: `run ${language} code${useWorkspace ? " (workspace mounted)" : ""}: ${safeDescription}`,
          action: { tool: "executeCode", args: { language, code, useWorkspace } },
          origin: "conversation",
          promptText,
        });

        // Never log the code body — only its shape (see gated-actions.ts).
        logger.debug(
          { confirmationId: id, chatId, language, codeLength: code.length },
          "Tool: executeCode",
        );
        return {
          pending: true,
          confirmationId: id,
          message: `Approval prompt sent with the code. Stop here — don't call this again in this turn. ${OWNER} will tap Approve or Deny.`,
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
