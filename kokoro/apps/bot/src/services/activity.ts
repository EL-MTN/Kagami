import type { ActivityKind, PlatformAdapter } from "@kokoro/shared";
import { logger } from "@kokoro/shared";

// Telegram paints a chat action (the "typing…" line under the chat name) for
// ~5 seconds and then lets it fade, so any turn that outlives one paint needs
// the action re-emitted. 4.5s keeps the indicator visually continuous with a
// safety margin, at one cheap API call per chat per beat.
const BEAT_MS = 4_500;

export interface ActivityHandle {
  /** Switch the indicator verb. Emits immediately when the kind changes. */
  set(kind: ActivityKind): void;
  /** Return the indicator to the default `typing` verb. */
  reset(): void;
  /** Stop the heartbeat. Idempotent; later set/reset calls are ignored. */
  stop(): void;
}

const inertHandle: ActivityHandle = {
  set: () => undefined,
  reset: () => undefined,
  stop: () => undefined,
};

/**
 * Start a chat-activity heartbeat for one user-facing turn: an immediate
 * `typing` emit, then a re-emit of the current verb every beat until stop().
 * Long media tools switch the verb via set() (see the stage map in
 * ai/tools/index.ts); everything else rides the default `typing`.
 *
 * Fail-open by contract: an indicator must never break a turn, so every emit
 * swallows errors (debug-logged). Returns an inert handle when the adapter
 * has no activity support (iMessage/BlueBubbles today), so callers never
 * branch on platform.
 */
export function startActivity(adapter: PlatformAdapter, chatId: string): ActivityHandle {
  const send = adapter.sendActivity?.bind(adapter);
  if (!send) return inertHandle;

  let current: ActivityKind = "typing";
  let stopped = false;

  const emit = (): void => {
    if (stopped) return;
    send(chatId, current).catch((error: unknown) => {
      logger.debug({ error, chatId }, "Chat activity emit failed");
    });
  };

  emit();
  const timer = setInterval(emit, BEAT_MS);
  // A leaked heartbeat must never hold the process open (tests, shutdown).
  // stop() in the owner's finally is the correct path; unref is the backstop.
  timer.unref();

  const set = (kind: ActivityKind): void => {
    if (stopped || kind === current) return;
    current = kind;
    emit();
  };

  return {
    set,
    reset: () => {
      set("typing");
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Wrap a tool's execute so the chat indicator carries `kind` while the tool
 * runs, then falls back to `typing` for the next LLM step. Parallel tool
 * calls within a step are last-write-wins — Telegram renders a single verb,
 * so contention isn't worth arbitrating. The activity handle is resolved at
 * call time (not wrap time): the palette is assembled once per turn, but the
 * handle only exists on paths where a user is watching the chat.
 */
export function wrapExecuteWithStage<Args, Options, Result>(
  execute: (args: Args, options: Options) => PromiseLike<Result> | Result,
  kind: ActivityKind,
  getActivity: () => ActivityHandle | undefined,
): (args: Args, options: Options) => Promise<Result> {
  return async (args, options) => {
    const activity = getActivity();
    activity?.set(kind);
    try {
      return await execute(args, options);
    } finally {
      activity?.reset();
    }
  };
}
