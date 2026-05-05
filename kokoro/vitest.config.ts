import { defineConfig } from "vitest/config";

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
    globalSetup: ["./packages/test-utils/src/global-setup.ts"],
    coverage: {
      provider: "v8",
      // `all: true` walks the include glob and reports 0%-covered files even
      // if the suite never imported them — needed for an accurate coverage
      // map. Without it, untested files silently disappear from the report.
      all: true,
      include: ["apps/bot/src/**/*.ts", "packages/{shared,db,memory}/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/tests/**",
        "**/dist/**",
        "**/node_modules/**",
        // index.ts files are pure re-exports — measuring them is noise.
        "**/src/index.ts",
        // type-only files
        "apps/bot/src/stt/types.ts",
        "packages/shared/src/types.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
    },
    projects: [
      {
        test: {
          name: "bot",
          root: "./apps/bot",
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      {
        test: {
          name: "shared",
          root: "./packages/shared",
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      {
        test: {
          name: "db",
          root: "./packages/db",
          include: ["tests/**/*.test.ts"],
          globals: true,
          environment: "node",
        },
      },
      {
        test: {
          name: "memory",
          root: "./packages/memory",
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
