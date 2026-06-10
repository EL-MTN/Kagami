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
 *   --env <proxy vars>=       Docker injects the client's ~/.docker/config.json
 *                             proxy settings (which can carry credentials) into
 *                             every container; pinned EMPTY overrides keep the
 *                             env secret-free. No other --env flags exist —
 *                             host secrets never enter.
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

/**
 * Container names are boot-scoped (`kokoro-exec-<bootId>-<uuid>`) so the
 * startup orphan sweep can never reap a live run: the sweep removes only
 * names from OTHER boots. That keeps it safe to fire-and-forget while
 * approvals are already being dispatched — a slow `docker ps` pass would
 * otherwise race a run approved right after restart and kill it as an
 * "orphan". Exported for tests.
 */
export const BOOT_NAME_PREFIX = `${CONTAINER_NAME_PREFIX}${randomUUID().slice(0, 8)}-`;

/**
 * Timeout-reap retry policy. A single missed `docker rm -f` (the daemon
 * hasn't registered the name yet, or a transient client failure) would leave
 * the container running past the deadline with the attached `docker run`
 * holding a semaphore slot indefinitely — so the reaper retries until the rm
 * lands, the run settles on its own, or the attempts are exhausted (then the
 * docker client is killed as a backstop: the slot frees, and any surviving
 * container is left for the next boot's sweep).
 */
const REAP_ATTEMPTS = 5;
const REAP_RETRY_DELAY_MS = 250;

/**
 * Per-attempt bound on a reap's `docker rm -f`. A wedged daemon can accept
 * the connection and then never respond — an unbounded await would pin the
 * retry loop on a single never-settling attempt, so its give-up paths (the
 * client-kill backstop, the overflow error log) would never run. Killing the
 * rm CLIENT is always safe; the loop just tries again.
 */
const REAP_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Docker injects HTTP_PROXY/HTTPS_PROXY/FTP_PROXY/ALL_PROXY/NO_PROXY (both
 * cases) into every container when the invoking client's
 * ~/.docker/config.json carries proxy settings — and proxy URLs routinely
 * embed credentials. `--network none` blocks their USE, not their READ:
 * approved code could simply print them. Explicit empty `--env VAR=` flags
 * beat the config.json injection, so the container env stays secret-free on
 * proxy-configured hosts too.
 */
const PROXY_ENV_OVERRIDES = ["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY"]
  .flatMap((name) => [name, name.toLowerCase()])
  .flatMap((name) => ["--env", `${name}=`]);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Force-remove a container, retrying per REAP_ATTEMPTS — `rm -f` removes what
 * exists NOW (it does not schedule a future kill), so one attempt that misses
 * or fails would leave the container running. Each attempt is bounded by
 * REAP_ATTEMPT_TIMEOUT_MS. `shouldStop` short-circuits between attempts (the
 * timeout path passes "has the run already exited?" — then `--rm` has already
 * cleaned up and further attempts are pointless). Returns false only when
 * every attempt failed and the container may still be alive.
 */
async function removeContainerWithRetry(
  name: string,
  shouldStop?: () => boolean,
): Promise<boolean> {
  for (let attempt = 1; attempt <= REAP_ATTEMPTS; attempt++) {
    try {
      await execFileAsync("docker", ["rm", "-f", name], {
        timeout: REAP_ATTEMPT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      return true;
    } catch {
      if (shouldStop?.()) return true;
      if (attempt < REAP_ATTEMPTS) await delay(REAP_RETRY_DELAY_MS);
      if (shouldStop?.()) return true;
    }
  }
  return false;
}

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
  // No trimming and no separator: this string is relayed to the conversation
  // as "what the code printed", and for text-generating programs leading or
  // trailing whitespace IS part of the result. Plain concatenation (stdout
  // then stderr) adds and removes nothing — only the cap may alter it.
  const combined = stdout + stderr;
  if (combined.length <= OUTPUT_CAP) return combined;
  return `${combined.slice(0, OUTPUT_CAP)}…[truncated ${combined.length - OUTPUT_CAP}]`;
}

export async function runCode(opts: RunCodeOptions): Promise<RunCodeResult> {
  const timeoutMs = opts.timeoutMs ?? config.EXECUTE_CODE_TIMEOUT_MS;
  const memoryMb = opts.memoryMb ?? config.EXECUTE_CODE_MEMORY_MB;
  const image =
    opts.language === "python" ? config.EXECUTE_CODE_PYTHON_IMAGE : config.EXECUTE_CODE_NODE_IMAGE;
  const name = `${BOOT_NAME_PREFIX}${randomUUID()}`;

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
    ...PROXY_ENV_OVERRIDES,
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

    // Settlement flag for the reaper: once `docker run` has exited (any
    // outcome), further rm retries are pointless — `--rm` already cleaned up.
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Node's `timeout` option only kills the docker *client*; the container
    // would keep running. Own timer → `docker rm -f` kills the container,
    // which makes the attached `docker run` exit. Retried per REAP_ATTEMPTS —
    // `rm -f` removes what exists NOW, it does not schedule a future kill, so
    // one attempt that misses (or fails) would let the run outlive the cap.
    const reapUntilGone = async (): Promise<void> => {
      if (await removeContainerWithRetry(name, () => settled)) return;
      // A container shouldn't survive repeated forced removals — assume the
      // daemon is wedged. Kill the client so the awaited run settles and the
      // semaphore slot frees; any surviving container becomes an orphan for
      // the next boot's sweep.
      logger.error({ name }, "Code-exec timeout reap failed; killing docker client");
      child.kill("SIGKILL");
    };

    timer = setTimeout(() => {
      timedOut = true;
      void reapUntilGone();
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
    // The reap is AWAITED and RETRIED: returning releases the semaphore slot
    // (finally), so a single rm that failed transiently would free the slot
    // with the container still burning CPU/memory — an output-flooding script
    // could escape the concurrency cap. (The timeout path needs no such await
    // — there `docker run` itself only exits once the rm lands, so settling
    // is the synchronization.) On total failure the leak is logged and the
    // container is left for the next boot's sweep.
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      if (!(await removeContainerWithRetry(name))) {
        logger.error(
          { name },
          "Code-exec overflow reap failed; container left for next boot's sweep",
        );
      }
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
    // Names from the CURRENT boot are skipped: those are (or are about to be)
    // live runs, not orphans — this is what lets the sweep run concurrently
    // with dispatch instead of blocking startup.
    const names = stdout
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.startsWith(CONTAINER_NAME_PREFIX) && !n.startsWith(BOOT_NAME_PREFIX));
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
