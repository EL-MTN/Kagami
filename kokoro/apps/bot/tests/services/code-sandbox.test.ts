import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The module under test wraps `promisify(execFile)` and reads `.child` off the
 * returned promise — that shape comes from execFile's `promisify.custom`
 * implementation in real Node. The mock reproduces it: `execFileMock` is the
 * raw callback-style fn (the module only ever calls it through `promisify`),
 * and `promisifiedMock` is attached under the registered promisify symbol so
 * `promisify(execFile)` resolves to it.
 */
const { execFileMock, promisifiedMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  const promisifiedMock = vi.fn();
  (execFileMock as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] =
    promisifiedMock;
  return { execFileMock, promisifiedMock };
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

// Pin the sandbox config so a stray EXECUTE_CODE_* in the test environment
// can't bend the pinned-args assertions below.
vi.mock("@kokoro/shared", async (orig) => {
  const real = await orig<typeof import("@kokoro/shared")>();
  return {
    ...real,
    config: {
      ...real.config,
      EXECUTE_CODE_PYTHON_IMAGE: "python:3.12-slim",
      EXECUTE_CODE_NODE_IMAGE: "node:22-slim",
      EXECUTE_CODE_TIMEOUT_MS: 120_000,
      EXECUTE_CODE_MEMORY_MB: 512,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    },
  };
});

import {
  runCode,
  sweepOrphanContainers,
  pullImages,
  CodeSandboxError,
  BOOT_NAME_PREFIX,
} from "../../src/services/code-sandbox";

interface FakeChild {
  stdin: { on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  return { stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() };
}

type RunResolution = { stdout: string; stderr: string };

/** Build a promise-with-child the way promisified execFile would return it. */
function pendingRun() {
  let resolve!: (v: RunResolution) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<RunResolution>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const child = fakeChild();
  (promise as unknown as { child: FakeChild }).child = child;
  return { promise, resolve, reject, child };
}

function resolvedRun(stdout: string, stderr = "") {
  const run = pendingRun();
  run.resolve({ stdout, stderr });
  return run;
}

function rejectedRun(props: { code?: number | string; stdout?: string; stderr?: string }) {
  const run = pendingRun();
  run.reject(Object.assign(new Error("docker run failed"), { stdout: "", stderr: "", ...props }));
  return run;
}

beforeEach(() => {
  execFileMock.mockReset();
  promisifiedMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runCode — docker invocation", () => {
  it("pins the full locked-down args array for python", async () => {
    promisifiedMock.mockReturnValueOnce(resolvedRun("42\n").promise);

    await runCode({ language: "python", code: "print(42)" });

    const [file, args, opts] = promisifiedMock.mock.calls[0] as [
      string,
      string[],
      { maxBuffer: number },
    ];
    expect(file).toBe("docker");
    const name = args[args.indexOf("--name") + 1];
    // Boot-scoped: `kokoro-exec-<8-hex bootId>-<uuid>` — the startup sweep
    // skips the current boot's prefix so it can never reap a live run.
    expect(name).toMatch(/^kokoro-exec-[0-9a-f]{8}-[0-9a-f-]{36}$/);
    expect(name.startsWith(BOOT_NAME_PREFIX)).toBe(true);
    // Every flag here is part of the security profile — a diff in this list
    // is a sandbox change and must be deliberate.
    expect(args).toEqual([
      "run",
      "--rm",
      // Pulls happen only at startup (pullImages) — a mid-run pull would be
      // unkillable by the timeout's `docker rm -f` (no container exists yet).
      "--pull",
      "never",
      "--name",
      name,
      "--network",
      "none",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
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
      "python:3.12-slim",
      "python3",
      "-",
    ]);
    // No --env / -e anywhere: the container env stays empty.
    expect(args).not.toContain("--env");
    expect(args).not.toContain("-e");
    expect(opts.maxBuffer).toBe(1024 * 1024);
  });

  it("runs node code under the node image with `node -`", async () => {
    promisifiedMock.mockReturnValueOnce(resolvedRun("1\n").promise);

    await runCode({ language: "node", code: "console.log(1)" });

    const args = promisifiedMock.mock.calls[0][1] as string[];
    expect(args.slice(-3)).toEqual(["node:22-slim", "node", "-"]);
  });

  it("writes the code via stdin (never argv) and swallows EPIPE", async () => {
    const run = resolvedRun("ok");
    promisifiedMock.mockReturnValueOnce(run.promise);

    await runCode({ language: "python", code: "print('ok')" });

    // Code travels via stdin only — it must not appear in the args array.
    const args = promisifiedMock.mock.calls[0][1] as string[];
    expect(args).not.toContain("print('ok')");
    expect(run.child.stdin.end).toHaveBeenCalledWith("print('ok')");
    // The EPIPE swallow handler is attached BEFORE the write.
    expect(run.child.stdin.on).toHaveBeenCalledWith("error", expect.any(Function));
    const onOrder = run.child.stdin.on.mock.invocationCallOrder[0];
    const endOrder = run.child.stdin.end.mock.invocationCallOrder[0];
    expect(onOrder).toBeLessThan(endOrder);
  });
});

describe("runCode — results", () => {
  it("returns stdout+stderr combined and capped at 4000 chars", async () => {
    promisifiedMock.mockReturnValueOnce(resolvedRun("a".repeat(5000)).promise);

    const result = await runCode({ language: "python", code: "x" });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
    expect(result.outputOverflow).toBe(false);
    expect(result.output).toBe(`${"a".repeat(4000)}…[truncated 1000]`);
  });

  it("preserves the output's own whitespace — no trimming, no added separator", async () => {
    // For text-generating programs, leading/trailing whitespace IS the
    // result; what gets relayed must be exactly what the program printed
    // (stdout then stderr, plain concatenation).
    promisifiedMock.mockReturnValueOnce(resolvedRun("  line one\n\n", "warn: x\n").promise);

    const result = await runCode({ language: "python", code: "print()" });

    expect(result.output).toBe("  line one\n\nwarn: x\n");
  });

  it("treats a non-zero exit as a result, not an error", async () => {
    promisifiedMock.mockReturnValueOnce(
      rejectedRun({ code: 1, stderr: "Traceback (most recent call last): boom" }).promise,
    );

    const result = await runCode({ language: "python", code: "raise" });

    expect(result.exitCode).toBe(1);
    expect(result.oomKilled).toBe(false);
    expect(result.output).toContain("Traceback");
  });

  it("flags exit 137 without a timeout as OOM-killed", async () => {
    promisifiedMock.mockReturnValueOnce(rejectedRun({ code: 137 }).promise);

    const result = await runCode({ language: "python", code: "eat all the memory" });

    expect(result.exitCode).toBe(137);
    expect(result.oomKilled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("on maxBuffer overflow, awaits the container reap and flags outputOverflow", async () => {
    promisifiedMock
      .mockReturnValueOnce(
        rejectedRun({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "b".repeat(5000) })
          .promise,
      )
      // The follow-up `docker rm -f` goes through the promisified path so it
      // can be AWAITED — the semaphore slot must not free while the container
      // is still running.
      .mockResolvedValue({ stdout: "", stderr: "" });

    const result = await runCode({ language: "python", code: "flood" });

    expect(result.output).toBe(`${"b".repeat(4000)}…[truncated 1000]`);
    expect(result.timedOut).toBe(false);
    // The program was stopped before its real exit status was known — this is
    // a failed run, not a success with noisy output.
    expect(result.outputOverflow).toBe(true);
    // The docker client died first — the container must be reaped explicitly,
    // before runCode returns (the await guarantees ordering: rm is already
    // recorded by the time the result lands).
    const rmCall = promisifiedMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "rm",
    ) as [string, string[]] | undefined;
    expect(rmCall).toBeDefined();
    expect(rmCall![1]).toEqual(["rm", "-f", expect.stringMatching(/^kokoro-exec-/)]);
  });

  it("kills the container via `docker rm -f` when the timeout fires and reports timedOut", async () => {
    const run = pendingRun();
    promisifiedMock.mockReturnValueOnce(run.promise);
    // The reaper's rm goes through the promisified path. Simulate the kill
    // landing: the attached `docker run` exits 137.
    promisifiedMock.mockImplementationOnce((_file, args) => {
      expect(args).toEqual(["rm", "-f", expect.stringMatching(/^kokoro-exec-/)]);
      run.reject(Object.assign(new Error("killed"), { code: 137, stdout: "partial", stderr: "" }));
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const result = await runCode({ language: "python", code: "while True: pass", timeoutMs: 30 });

    expect(result.timedOut).toBe(true);
    expect(result.oomKilled).toBe(false);
    expect(result.output).toBe("partial");
    expect(promisifiedMock).toHaveBeenCalledWith("docker", [
      "rm",
      "-f",
      expect.stringMatching(/^kokoro-exec-/),
    ]);
  });

  it("retries the reap when an rm attempt misses (rm removes what exists NOW — it cannot pre-kill)", async () => {
    const run = pendingRun();
    promisifiedMock.mockReturnValueOnce(run.promise);
    // First rm fails (e.g. the daemon hasn't registered the name yet); the
    // retry lands and kills the run. Without it the container would run past
    // the deadline holding a semaphore slot.
    promisifiedMock
      .mockRejectedValueOnce(Object.assign(new Error("No such container"), { code: 1 }))
      .mockImplementationOnce(() => {
        run.reject(Object.assign(new Error("killed"), { code: 137, stdout: "", stderr: "" }));
        return Promise.resolve({ stdout: "", stderr: "" });
      });

    const result = await runCode({ language: "python", code: "while True: pass", timeoutMs: 30 });

    expect(result.timedOut).toBe(true);
    const rmCalls = promisifiedMock.mock.calls.filter((c) => (c[1] as string[])[0] === "rm");
    expect(rmCalls).toHaveLength(2);
  });

  it("kills the docker client as a last resort when every reap attempt fails (the slot must free)", async () => {
    const run = pendingRun();
    promisifiedMock.mockReturnValueOnce(run.promise);
    // Daemon wedged: all rm attempts fail. The reaper gives up and SIGKILLs
    // the client so the awaited run settles (freeing the semaphore slot); any
    // surviving container is left for the next boot's sweep.
    promisifiedMock.mockRejectedValue(Object.assign(new Error("daemon wedged"), { code: 1 }));
    run.child.kill.mockImplementation(() => {
      run.reject(Object.assign(new Error("killed"), { stdout: "", stderr: "" }));
      return true;
    });

    const result = await runCode({ language: "python", code: "while True: pass", timeoutMs: 30 });

    expect(result.timedOut).toBe(true);
    expect(run.child.kill).toHaveBeenCalledWith("SIGKILL");
    const rmCalls = promisifiedMock.mock.calls.filter((c) => (c[1] as string[])[0] === "rm");
    expect(rmCalls).toHaveLength(5);
  });
});

describe("runCode — infrastructure errors", () => {
  it("maps a missing docker binary (ENOENT) to daemon_unavailable", async () => {
    promisifiedMock.mockReturnValueOnce(rejectedRun({ code: "ENOENT" }).promise);

    await expect(runCode({ language: "python", code: "x" })).rejects.toMatchObject({
      name: "CodeSandboxError",
      kind: "daemon_unavailable",
    });
  });

  it("maps a dead daemon socket to daemon_unavailable", async () => {
    promisifiedMock.mockReturnValueOnce(
      rejectedRun({
        code: 1,
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      }).promise,
    );

    await expect(runCode({ language: "python", code: "x" })).rejects.toMatchObject({
      kind: "daemon_unavailable",
    });
  });

  it("maps exit 125 + 'No such image' (--pull=never refusal) to image_missing", async () => {
    promisifiedMock.mockReturnValueOnce(
      rejectedRun({
        code: 125,
        stderr: "docker: Error response from daemon: No such image: python:3.12-slim",
      }).promise,
    );

    await expect(runCode({ language: "python", code: "x" })).rejects.toMatchObject({
      kind: "image_missing",
    });
  });

  it("still maps the auto-pull failure string ('Unable to find image') to image_missing", async () => {
    promisifiedMock.mockReturnValueOnce(
      rejectedRun({
        code: 125,
        stderr: "Unable to find image 'python:3.12-slim' locally",
      }).promise,
    );

    await expect(runCode({ language: "python", code: "x" })).rejects.toMatchObject({
      kind: "image_missing",
    });
  });

  it("wraps anything unclassifiable as an internal CodeSandboxError", async () => {
    promisifiedMock.mockReturnValueOnce(rejectedRun({ code: "EWEIRD" }).promise);

    await expect(runCode({ language: "python", code: "x" })).rejects.toBeInstanceOf(
      CodeSandboxError,
    );
  });
});

describe("runCode — concurrency", () => {
  it("admits at most 2 concurrent runs; a third waits for a slot", async () => {
    const runs = [pendingRun(), pendingRun(), pendingRun()];
    let started = 0;
    promisifiedMock.mockImplementation(() => runs[started++].promise);

    const p1 = runCode({ language: "python", code: "1" });
    const p2 = runCode({ language: "python", code: "2" });
    const p3 = runCode({ language: "python", code: "3" });

    await vi.waitFor(() => expect(promisifiedMock).toHaveBeenCalledTimes(2));
    // The third run is queued — no docker invocation yet.
    expect(promisifiedMock).toHaveBeenCalledTimes(2);

    runs[0].resolve({ stdout: "done", stderr: "" });
    await p1;
    await vi.waitFor(() => expect(promisifiedMock).toHaveBeenCalledTimes(3));

    runs[1].resolve({ stdout: "done", stderr: "" });
    runs[2].resolve({ stdout: "done", stderr: "" });
    await Promise.all([p2, p3]);
  });
});

describe("sweepOrphanContainers", () => {
  it("removes only true kokoro-exec- prefixed containers", async () => {
    promisifiedMock
      .mockResolvedValueOnce({
        // `--filter name=` is substring matching — the third entry must survive.
        stdout: "kokoro-exec-aaa\nkokoro-exec-bbb\nmy-kokoro-exec-impostor\n",
        stderr: "",
      })
      .mockResolvedValue({ stdout: "", stderr: "" });

    await sweepOrphanContainers();

    expect(promisifiedMock).toHaveBeenCalledWith("docker", [
      "ps",
      "-a",
      "--filter",
      "name=kokoro-exec-",
      "--format",
      "{{.Names}}",
    ]);
    const rmCalls = promisifiedMock.mock.calls.filter((c) => (c[1] as string[])[0] === "rm");
    expect(rmCalls.map((c) => c[1] as string[])).toEqual([
      ["rm", "-f", "kokoro-exec-aaa"],
      ["rm", "-f", "kokoro-exec-bbb"],
    ]);
  });

  it("never removes containers from the current boot (they are live runs, not orphans)", async () => {
    // This is what makes the fire-and-forget startup sweep race-free: a run
    // approved while the sweep's `docker ps` is still in flight carries the
    // current boot's prefix and must survive.
    promisifiedMock
      .mockResolvedValueOnce({
        stdout: `kokoro-exec-aaa\n${BOOT_NAME_PREFIX}1111\n`,
        stderr: "",
      })
      .mockResolvedValue({ stdout: "", stderr: "" });

    await sweepOrphanContainers();

    const rmCalls = promisifiedMock.mock.calls.filter((c) => (c[1] as string[])[0] === "rm");
    expect(rmCalls.map((c) => c[1] as string[])).toEqual([["rm", "-f", "kokoro-exec-aaa"]]);
  });

  it("is fail-open when docker is unavailable", async () => {
    promisifiedMock.mockRejectedValue(Object.assign(new Error("no docker"), { code: "ENOENT" }));

    await expect(sweepOrphanContainers()).resolves.toBeUndefined();
  });

  it("keeps sweeping when one rm fails", async () => {
    promisifiedMock
      .mockResolvedValueOnce({ stdout: "kokoro-exec-aaa\nkokoro-exec-bbb\n", stderr: "" })
      .mockRejectedValueOnce(new Error("already gone"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(sweepOrphanContainers()).resolves.toBeUndefined();
    const rmCalls = promisifiedMock.mock.calls.filter((c) => (c[1] as string[])[0] === "rm");
    expect(rmCalls).toHaveLength(2);
  });
});

describe("pullImages", () => {
  it("pulls both configured images", async () => {
    promisifiedMock.mockResolvedValue({ stdout: "", stderr: "" });

    await pullImages();

    const pulled = promisifiedMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(pulled).toContain("pull python:3.12-slim");
    expect(pulled).toContain("pull node:22-slim");
  });

  it("is fail-open when a pull fails", async () => {
    promisifiedMock.mockRejectedValue(new Error("registry unreachable"));

    await expect(pullImages()).resolves.toBeUndefined();
  });
});
