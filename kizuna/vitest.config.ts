import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: projectRoot,
    include: ["apps/api/tests/**/*.test.ts"],
    globalSetup: [resolve(projectRoot, "apps/api/tests/global-setup.ts")],
    setupFiles: [resolve(projectRoot, "apps/api/tests/setup.ts")],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
    isolate: false,
  },
});
