import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { config, logger } from "@kokoro/shared";

const execFileAsync = promisify(execFile);

/**
 * Ephemeral Docker sandbox for the `executeCode` gated action. This module
 * knows nothing about the AI or confirmation layers — it takes code, runs it
 * in a locked-down throwaway container, and returns the outcome.
 *
 * Sandbox profile (every flag is load-bearing — tests pin the exact array):
 *   --network none            no network, full stop (no exfil, no installs)
 *   (no --env flags)          container env is empty — host secrets never enter
 *   --cap-drop ALL            no Linux capabilities
 *   --security-opt no-new-privileges   no setuid escalation
 *   --read-only + --tmpfs /tmp         immutable rootfs, 64 MB scratch only
 *   --user 65534:65534        numeric nobody (works even if the image has no
 *                             `nobody` user entry)
 *   --pids-limit / --memory / --memory-swap / --cpus   fork-bomb + OOM + CPU caps
 *   --rm + unique name        ephemeral; the name lets the host kill it on timeout
 *   --pull never              images come from the startup pre-pull only — a
 *                             registry download mid-`run` would be unkillable
 *                             by the timeout's `docker rm -f` (no container
 *                             exists yet) and could overrun the deadline
 *
 * Non-zero exit, timeout, OOM, and output overflow are *results* (the LLM
 * reacts to them); `CodeSandboxError` is reserved for infrastructure faults
 * (daemon down, image missing, unexpected client failure).
 */

export type SandboxLanguage = "python" | "node";

export interface RunCodeOptions {
  language: SandboxLanguage;
  code: string;
  /** Wall-clock cap. Defaults to config.EXECUTE_CODE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Hard memory cap (swap pinned to the same value). Defaults to config.EXECUTE_CODE_MEMORY_MB. */
  memoryMb?: number;
}

export interface RunCodeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  /**
   * True when stdout+stderr blew past the 1 MB client buffer and the run was
   * stopped early. The exit code is unknowable then (the client died first) —
   * this flag, not exitCode, is the authoritative failure signal.
   */
  outputOverflow: boolean;
  /** Combined stdout+stderr, capped at OUTPUT_CAP — ready for the LLM. */
  output: string;
}

export type CodeSandboxErrorKind = "daemon_unavailable" | "image_missing" | "internal";

export class CodeSandboxError extends Error {
  readonly kind: CodeSandboxErrorKind;

  constructor(kind: CodeSandboxErrorKind, message: string) {
    super(message);
    this.name = "CodeSandboxError";
    this.kind = kind;
  }
}

/** Matches the browseAgent result-cap convention (gated-actions.ts). */
const OUTPUT_CAP = 4000;

/** stdout/stderr buffer cap on the docker client; overflow returns partial output. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Image pre-pull deadline — slim images are ~50-80 MB, 5 min is generous. */
const PULL_TIMEOUT_MS = 5 * 60 * 1000;

const CONTAINER_NAME_PREFIX = "kokoro-exec-";

// ─── concurrency ─────────────────────────────────────────────────────────────

// Counting semaphore: at most two sandboxes at once. Code execution is
// CPU/memory-bound and approval-gated — bursts beyond two mean something is
// wrong upstream; queueing (not rejecting) keeps the dispatcher simple.
const MAX_CONCURRENT = 2;
let activeRuns = 0;
const waiters: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (activeRuns < MAX_CONCURRENT) {
    activeRuns++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next(); // slot transfers to the waiter — activeRuns stays constant
  } else {
    activeRuns--;
  }
}

// ─── runCode ─────────────────────────────────────────────────────────────────

interface ExecFileFailure {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

function buildOutput(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (combined.length <= OUTPUT_CAP) return combined;
  return `${combined.slice(0, OUTPUT_CAP)}…[truncated ${combined.length - OUTPUT_CAP}]`;
}

export async function runCode(opts: RunCodeOptions): Promise<RunCodeResult> {
  const timeoutMs = opts.timeoutMs ?? config.EXECUTE_CODE_TIMEOUT_MS;
  const memoryMb = opts.memoryMb ?? config.EXECUTE_CODE_MEMORY_MB;
  const image =
    opts.language === "python" ? config.EXECUTE_CODE_PYTHON_IMAGE : config.EXECUTE_CODE_NODE_IMAGE;
  const name = `${CONTAINER_NAME_PREFIX}${randomUUID()}`;

  // Args array, never a shell — the code body only ever travels via stdin.
  const args = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    "1",
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m",
    "--user",
    "65534:65534",
    "-i",
    image,
    ...(opts.language === "python" ? ["python3", "-"] : ["node", "-"]),
  ];

  await acquireSlot();

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const promise = execFileAsync("docker", args, { maxBuffer: MAX_BUFFER_BYTES });
    const child = promise.child;

    // Node's `timeout` option only kills the docker *client*; the container
    // would keep running. Own timer → `docker rm -f` kills the container,
    // which makes the attached `docker run` exit.
    timer = setTimeout(() => {
      timedOut = true;
      execFile("docker", ["rm", "-f", name], () => {});
    }, timeoutMs);

    if (child.stdin) {
      // EPIPE lands here when the container exits before consuming stdin
      // (e.g. an early interpreter crash); swallowing it lets execFile
      // complete with the real exit code and stderr.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.code);
    }

    const { stdout, stderr } = await promise;
    return {
      exitCode: 0,
      stdout,
      stderr,
      timedOut: false,
      oomKilled: false,
      outputOverflow: false,
      output: buildOutput(stdout, stderr),
    };
  } catch (error) {
    const e = error as ExecFileFailure;
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";

    // Docker binary missing entirely.
    if (e.code === "ENOENT") {
      throw new CodeSandboxError(
        "daemon_unavailable",
        "Docker is not installed or not on PATH — code execution is unavailable.",
      );
    }

    // Output exceeded maxBuffer: Node killed the docker client, but the
    // container is still running — kill it, then return the partial output
    // with `outputOverflow` set. The program was stopped before its real exit
    // status was known, so this is a *failed* run (the dispatcher reports it
    // as such); exitCode 0 here is a placeholder, not a success claim.
    // The reap is AWAITED: returning releases the semaphore slot (finally),
    // and a fire-and-forget rm would let overflow-heavy runs stack live
    // containers beyond MAX_CONCURRENT until docker catches up. (The timeout
    // path needs no such await — there `docker run` itself only exits once
    // the rm lands, so settling is the synchronization.)
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
      return {
        exitCode: 0,
        stdout,
        stderr,
        timedOut: false,
        oomKilled: false,
        outputOverflow: true,
        output: buildOutput(stdout, stderr),
      };
    }

    if (timedOut) {
      return {
        exitCode: typeof e.code === "number" ? e.code : 137,
        stdout,
        stderr,
        timedOut: true,
        oomKilled: false,
        outputOverflow: false,
        output: buildOutput(stdout, stderr),
      };
    }

    // Daemon not reachable (binary exists, socket dead).
    if (
      e.code === "ECONNREFUSED" ||
      stderr.includes("Cannot connect to the Docker daemon") ||
      stderr.includes("ECONNREFUSED")
    ) {
      throw new CodeSandboxError(
        "daemon_unavailable",
        "Docker daemon is not running — code execution is unavailable until it's started.",
      );
    }

    // Exit 125 = the docker client itself failed. "No such image" is the
    // --pull=never refusal (image absent locally); "Unable to find image" is
    // the auto-pull failure string — matched too in case the pull policy ever
    // regresses.
    if (
      e.code === 125 &&
      (stderr.includes("No such image") || stderr.includes("Unable to find image"))
    ) {
      throw new CodeSandboxError(
        "image_missing",
        `Sandbox image "${image}" is not available locally — pull it (or restart the bot with registry access) to enable code execution.`,
      );
    }

    if (typeof e.code === "number") {
      // 137 = SIGKILL. We didn't send it (no timeout), so with --memory set
      // the overwhelmingly likely sender is the kernel OOM killer. Heuristic —
      // v1 skips the authoritative `docker inspect` round-trip.
      const oomKilled = e.code === 137;
      return {
        exitCode: e.code,
        stdout,
        stderr,
        timedOut: false,
        oomKilled,
        outputOverflow: false,
        output: buildOutput(stdout, stderr),
      };
    }

    throw new CodeSandboxError(
      "internal",
      `Sandbox run failed unexpectedly: ${e.message ?? "unknown error"}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    releaseSlot();
  }
}

// ─── lifecycle helpers (startup) ─────────────────────────────────────────────

/**
 * Remove leftover kokoro-exec containers from a previous process that died
 * mid-run (the timeout killer never fired, so `--rm` never triggered).
 * Fail-open: docker being down just means there's nothing to sweep yet.
 */
export async function sweepOrphanContainers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `name=${CONTAINER_NAME_PREFIX}`,
      "--format",
      "{{.Names}}",
    ]);
    // `--filter name=` is substring matching — keep only true prefix matches
    // so an unrelated container that merely contains the string is untouched.
    const names = stdout
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.startsWith(CONTAINER_NAME_PREFIX));
    if (names.length === 0) return;

    logger.warn({ count: names.length }, "Sweeping orphan code-exec containers");
    await Promise.all(names.map((n) => execFileAsync("docker", ["rm", "-f", n]).catch(() => {})));
  } catch (error) {
    logger.debug({ error }, "Orphan code-exec container sweep skipped (docker unavailable?)");
  }
}

/**
 * Pre-pull both sandbox images. `docker run` is pinned to `--pull never` (a
 * mid-run pull would be unkillable by the timeout reaper), so this is the
 * ONLY pull path. Fail-open: a failed pull is a warning — runs surface
 * `image_missing` until the image lands (manual `docker pull` or restart
 * with registry access).
 */
export async function pullImages(): Promise<void> {
  const images = [...new Set([config.EXECUTE_CODE_PYTHON_IMAGE, config.EXECUTE_CODE_NODE_IMAGE])];
  await Promise.all(
    images.map(async (image) => {
      try {
        // Plain Node timeout is fine here — killing a `docker pull` client
        // just abandons the download, there's no container to orphan.
        await execFileAsync("docker", ["pull", image], {
          timeout: PULL_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER_BYTES,
        });
        logger.info({ image }, "Code-exec sandbox image ready");
      } catch (error) {
        logger.warn(
          { error, image },
          "Code-exec image pre-pull failed — first run may auto-pull or fail",
        );
      }
    }),
  );
}
