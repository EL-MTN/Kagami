import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Boot one mongodb-memory-server in the parent process before workers
    // spawn; each `withTestDb()` call connects to a unique database name
    // on that shared instance. Saves the ~1.5 s mongo cold-boot cost from
    // every worker that touches the DB.
    //
    // Other knobs measured but not adopted (no meaningful wall-clock win
    // on top of globalSetup): pool: "threads" / "vmThreads", isolate: false,
    // capped maxThreads, per-worker connection memoization. The remaining
    // ~8 s wall-clock is dominated by GridFS I/O in gridfs.test.ts and
    // heavy module imports per worker — both architectural rather than
    // tunable.
    globalSetup: [resolve(projectRoot, "packages/test-utils/src/global-setup.ts")],
    projects: [
      {
        test: {
          name: "bot",
          root: resolve(projectRoot, "apps/bot"),
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      {
        test: {
          name: "shared",
          root: resolve(projectRoot, "packages/shared"),
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      {
        test: {
          name: "db",
          root: resolve(projectRoot, "packages/db"),
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      {
        test: {
          name: "memory",
          root: resolve(projectRoot, "packages/memory"),
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      {
        test: {
          name: "kizuna",
          root: resolve(projectRoot, "packages/kizuna"),
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      // Cross-package pipeline tests will land at `tests/e2e/` as their own
      // project entry once the pipeline phase ships. Not declared here yet —
      // an empty project root makes vitest silently skip it, which obscures
      // intent.
    ],
  },
});
