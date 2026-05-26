import { defineConfig } from "vitest/config";

// Workspace-level vitest aggregator. Each per-project vitest.config.ts is
// preserved so `cd <project> && vitest` still works for focused iteration;
// this file lets `vitest run` from the workspace root drive ONE vitest
// process across all five projects, sharing the CLI startup cost and
// producing a single reporter output. Per-project globalSetup (each
// spawns its own mongodb-memory-server) is preserved — unifying Mongo
// would require coordinated changes in five global-setup.ts files and
// is deliberately not part of this consolidation.
//
// Invoked via `npm run test:all` from the workspace root. The existing
// `npm run test` (turbo-based) is kept intact for cache reuse and
// per-project filtering.
export default defineConfig({
  test: {
    projects: [
      "./kioku/vitest.config.ts",
      "./kokoro/vitest.config.ts",
      "./kizuna/vitest.config.ts",
      "./kansoku/vitest.config.ts",
      "./kao/vitest.config.ts",
    ],
  },
});
