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
];
