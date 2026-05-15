import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: projectRoot,
    include: ["apps/api/tests/**/*.test.ts"],
    globalSetup: ["./apps/api/tests/global-setup.ts"],
    globals: true,
    environment: "node",
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
