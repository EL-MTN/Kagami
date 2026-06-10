import type { EnvSpec } from "@kagami/env";

/**
 * Registry of migrated apps. Each entry's `load` imports that app's leaf
 * env-spec module (zod + @kagami/env only — importing it must never boot the
 * app). As services migrate onto @kagami/env, they get a row here and their
 * generated artifacts join `npm run env:gen` / `env:check`.
 *
 * Migration order (panel-reviewed, see docs in the @kagami/env PR):
 * Kao → Cockpit → Kizuna → Kansoku → Kioku → Kokoro.
 */
export interface AppTarget {
  /** Repo-root-relative app directory (receives .env.example / turbo.json). */
  appDir: string;
  load: () => Promise<EnvSpec<unknown>>;
  /** Project doc whose marked span receives the generated env table. */
  configDoc?: { path: string; markerId: string };
  /** Turbo tasks that execute this app and get its env keys declared. */
  turboTasks?: string[];
}

export const targets: AppTarget[] = [
  {
    appDir: "kao/apps/api",
    load: async () => (await import("../../kao/apps/api/src/env.js")).envSpec,
    configDoc: { path: "kao/docs/configuration.md", markerId: "kao/api" },
    turboTasks: ["dev", "test"],
  },
  {
    appDir: "cockpit/apps/dashboard",
    load: async () => (await import("../../cockpit/apps/dashboard/src/env.js")).envSpec,
    configDoc: { path: "cockpit/docs/configuration.md", markerId: "cockpit/dashboard" },
    // No test task (Cockpit has no test suite); `build` is declared because
    // `next build` executes the app, unlike the compiled Express APIs.
    turboTasks: ["dev", "build"],
  },
  {
    appDir: "kizuna/apps/api",
    load: async () => (await import("../../kizuna/apps/api/src/env.js")).envSpec,
    configDoc: { path: "kizuna/docs/configuration.md", markerId: "kizuna/api" },
    turboTasks: ["dev", "test"],
  },
  {
    appDir: "kansoku/apps/api",
    load: async () => (await import("../../kansoku/apps/api/src/env.js")).envSpec,
    configDoc: { path: "kansoku/docs/configuration.md", markerId: "kansoku/api" },
    turboTasks: ["dev", "test"],
  },
  {
    appDir: "kioku/apps/api",
    load: async () => (await import("../../kioku/apps/api/src/env.js")).envSpec,
    configDoc: { path: "kioku/docs/configuration.md", markerId: "kioku/api" },
    turboTasks: ["dev", "test"],
  },
  {
    // The spec lives in @kokoro/shared (the bot and dashboard both consume it
    // through the package barrel), but the artifacts belong to the bot app —
    // apps/bot/.env is the one .env Kokoro reads.
    appDir: "kokoro/apps/bot",
    load: async () => (await import("../../kokoro/packages/shared/src/env.js")).envSpec,
    configDoc: { path: "kokoro/docs/configuration.md", markerId: "kokoro/bot" },
    turboTasks: ["dev", "test"],
  },
];
