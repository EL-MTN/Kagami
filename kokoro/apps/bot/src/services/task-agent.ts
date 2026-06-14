import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { withCallOp } from "@kagami/llm";
import { getModel } from "../ai/provider";
import { extractResponseText } from "../ai/response";

const TASK_AGENT_TIMEOUT_MS = 180_000; // 3 minutes

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

interface TaskAgentResult {
  text: string;
  usage: GenerateTextResult["usage"];
  steps: number;
}

/**
 * The shared lean LLM task loop: one `generateText` step-loop over a tool
 * palette, returning the final text plus usage/step metadata.
 *
 * This is the execution core behind both `executeRoutine` (which wraps it with
 * the RoutineLog lifecycle, cron advance, and report delivery) and the
 * `delegate` tool's parallel read-only sub-tasks. It deliberately owns no
 * persistence, scheduling, or messaging — those stay with the callers so the
 * core stays reusable and side-effect-free.
 */
export async function runTaskAgent(opts: {
  system: string;
  prompt: string;
  tools: ToolSet;
  maxSteps: number;
  temperature: number;
  model?: LanguageModel;
  timeoutMs?: number;
}): Promise<TaskAgentResult> {
  const result = await withCallOp("task_agent", () =>
    generateText({
      model: opts.model ?? getModel(),
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      tools: opts.tools,
      stopWhen: stepCountIs(opts.maxSteps),
      temperature: opts.temperature,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? TASK_AGENT_TIMEOUT_MS),
    }),
  );

  const text = result.text || extractResponseText(result.steps) || "";
  return { text, usage: result.usage, steps: result.steps.length };
}
