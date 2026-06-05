import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { logger, runWithSpan, mapLimit } from "@kokoro/shared";
import { getRoutineByName } from "@kokoro/db";
import { runTaskAgent } from "../../services/task-agent";
import { executeRoutine } from "../../services/routine-executor";
import { getModelName } from "../provider";
import { trackUsage } from "../token-tracker";
import { DATETIME_CONTEXT } from "../prompts";
import { validateParameters } from "./routine-params";
import type { ToolContext } from "./index";

// Width and concurrency bounds. The width cap forces the model to fan out only
// genuinely independent work; the concurrency cap keeps the number of in-flight
// LLM calls bounded even when a fan-out is issued from inside a routine. Each
// sub-task runs read-only and cannot itself `delegate` (the inline builder is
// the watcher read-only subset, which has no `delegate`; routine-backed
// branches run under callingContext "watcher"), so the tree can never deepen
// past a single fan-out level.
const MAX_SUBTASKS = 6;
const SUBTASK_CONCURRENCY = 4;
// Sub-tasks are short, single-purpose read/gather jobs — same lean budget as a
// depth>0 composed routine call.
const SUBTASK_MAX_STEPS = 5;
const SUBTASK_TEMPERATURE = 0.4;

const SUBTASK_IDENTITY = `You are a focused sub-task worker dispatched as one branch of a parallel fan-out. Complete ONLY the single task described below using your read-only tools (web/browser search, memory recall, email/calendar reads, CRM reads). You cannot send, write, or modify anything — gather and analyse, then return your findings concisely and factually. Do not adopt a persona or use conversational tone.`;

interface SubtaskInput {
  label: string;
  prompt?: string;
  routineName?: string;
  parameters?: Record<string, unknown>;
}

type SubtaskResult =
  | { label: string; success: true; result: string }
  | { label: string; success: false; error: string };

/**
 * Run an existing routine as a read-only fan-out branch. Mirrors `useRoutine`'s
 * lookup + purity gate + parameter validation, but pins the run read-only:
 * delegate only fans out gathering, so an `action`-purity routine is rejected,
 * and the run uses `callingContext: "watcher"` so even a `read` routine can't
 * mutate through its own palette (the transitive watcher invariant). Returns
 * the routine's result text; throws a descriptive error the caller turns into a
 * failed branch.
 */
async function runRoutineSubtask(
  st: SubtaskInput,
  ctx: ToolContext,
  depth: number,
): Promise<string> {
  const routineName = st.routineName ?? "";
  const routine = await getRoutineByName(ctx.chatId, routineName);
  if (!routine) throw new Error(`Routine "${routineName}" not found`);
  if (!routine.enabled) throw new Error(`Routine "${routineName}" is disabled`);
  if (routine.purity !== "read") {
    throw new Error(
      `Routine "${routineName}" has purity "${routine.purity}" — delegate runs sub-tasks read-only, so only purity: "read" routines can be fanned out. Run an action routine directly instead.`,
    );
  }

  const validation = validateParameters(st.parameters, routine.parameters);
  if (!validation.valid) throw new Error(validation.reason);

  // trigger "routine" → never delivers its own report (delegate returns the
  // result to the caller); callingContext "watcher" → transitive read-only;
  // depth + 1 shares the recursion ceiling with useRoutine; parentLogId links
  // the spawned run to the calling routine's RoutineLog for the dashboard tree.
  // rethrow → a mid-run failure surfaces as a thrown error (caught per-branch
  // below into { success: false }) instead of executeRoutine's "Error: …"
  // string masquerading as a successful gather.
  return executeRoutine(routine, ctx.adapter, {
    trigger: "routine",
    parameters: validation.resolved,
    depth: depth + 1,
    callingContext: "watcher",
    parentLogId: ctx.routineLogId,
    rethrow: true,
  });
}

/**
 * `delegate` — fan out several INDEPENDENT read-only sub-tasks in parallel and
 * collect their results, instead of running them one after another with serial
 * tool calls or `useRoutine`.
 *
 * Each branch is either an inline `prompt` (runs as its own `runTaskAgent` call
 * on the read-only palette injected via `buildSubtaskTools` — so this module
 * never imports back into `./index`) or a `routineName` (runs an existing
 * read-purity routine via `executeRoutine`). Writes stay with the caller: fan
 * out the gathering, then act on the results yourself, sequentially and gated.
 */
export function createDelegateTool(
  ctx: ToolContext,
  buildSubtaskTools: (ctx: ToolContext) => ToolSet,
) {
  const depth = ctx.routineDepth ?? 0;

  return tool({
    description:
      "Run several INDEPENDENT read-only sub-tasks in parallel and collect their results. " +
      "Each sub-task is either an inline `prompt` or the `routineName` of an existing read-purity routine, " +
      "and runs as its own LLM call with a read-only tool palette (web/browser search, memory recall, " +
      "email/calendar reads, CRM reads) — sub-tasks CANNOT send, write, or mutate anything. " +
      "Use this to fan out independent lookups or research at once (e.g. weather + calendar + unread email) " +
      "instead of doing them one after another. Do any sending or writing yourself, after the results return. " +
      "If one task depends on another's output, run them in order instead.",
    inputSchema: z.object({
      subtasks: z
        .array(
          z
            .object({
              label: z
                .string()
                .describe("Short identifier for this sub-task (e.g. 'weather', 'inbox')"),
              prompt: z
                .string()
                .min(1)
                .optional()
                .describe("Inline read-only instructions. Provide EITHER prompt OR routineName."),
              routineName: z
                .string()
                .optional()
                .describe(
                  "Name of an existing read-purity routine to run as this branch. Provide EITHER routineName OR prompt.",
                ),
              parameters: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Parameters for routineName (ignored for inline prompts)"),
            })
            .refine((s) => (s.prompt == null) !== (s.routineName == null), {
              message: "Each sub-task needs exactly one of `prompt` or `routineName`",
            }),
        )
        .min(2)
        .max(MAX_SUBTASKS)
        .describe(
          `Between 2 and ${MAX_SUBTASKS} independent read-only sub-tasks to run in parallel`,
        ),
    }),
    execute: async ({ subtasks }: { subtasks: SubtaskInput[] }) => {
      // Sub-tasks run one nesting level deeper on the read-only palette. The
      // injected builder is the watcher read-only subset, so any nested
      // `useRoutine` is gated read-only and no further `delegate` is exposed.
      // Build the inline-branch palette + system prompt lazily — a fan-out of
      // only routine-backed branches never touches them.
      const childCtx: ToolContext = { ...ctx, routineDepth: depth + 1 };
      const hasInlineBranch = subtasks.some((st) => st.prompt != null);
      const tools = hasInlineBranch ? buildSubtaskTools(childCtx) : ({} as ToolSet);
      const baseSystem = hasInlineBranch
        ? `${SUBTASK_IDENTITY}\n\n---\n\n${DATETIME_CONTEXT(new Date())}`
        : "";

      logger.debug(
        { chatId: ctx.chatId, depth, count: subtasks.length },
        "Tool: delegate (parallel fan-out)",
      );

      const results = await mapLimit<SubtaskInput, SubtaskResult>(
        subtasks,
        SUBTASK_CONCURRENCY,
        async (st) => {
          try {
            const result = await runWithSpan("delegate.subtask", async () => {
              if (st.routineName) {
                return runRoutineSubtask(st, ctx, depth);
              }
              const r = await runTaskAgent({
                system: `${baseSystem}\n\n---\n\n## Sub-task: ${st.label}`,
                prompt: st.prompt ?? "",
                tools,
                maxSteps: SUBTASK_MAX_STEPS,
                temperature: SUBTASK_TEMPERATURE,
              });
              trackUsage("delegate", getModelName(), r.usage, {
                chatId: ctx.chatId,
                steps: r.steps,
              });
              return r.text;
            });
            return { label: st.label, success: true, result };
          } catch (error) {
            const reason = error instanceof Error ? error.message : "Sub-task failed";
            logger.warn({ error, label: st.label }, "delegate sub-task failed");
            return { label: st.label, success: false, error: reason };
          }
        },
      );

      return { success: true, results };
    },
  });
}
