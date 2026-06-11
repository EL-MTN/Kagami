import { z } from "zod";
import { defineEnv, type EnvOutput } from "@kagami/env";

/**
 * Cockpit dashboard env spec — the single source of truth for this app's
 * configuration. `.env.example`, the docs/configuration.md table, and
 * turbo.json env declarations are all generated from it: edit here, then
 * `npm run env:gen`.
 *
 * This module must stay a leaf (zod + @kagami/env only) so the workspace
 * generator can import it without booting the app.
 *
 * Cockpit is read-only and fail-open: every var is defaulted or optional, and
 * the URL keys are warn-default, so a bad value degrades to the Portless
 * default (with a console warning) instead of breaking the page.
 */

const serviceUrl = (fallback: string, doc: string) =>
  z.string().url().default(fallback).meta({
    doc,
    sharedAllowed: true,
    crossService: true,
    onInvalid: "warn-default",
    group: "Service endpoints",
  });

export const envSpec = defineEnv({
  service: "cockpit",
  component: "dashboard",
  vars: {
    KIOKU_API_URL: serviceUrl(
      "https://api.kioku.localhost",
      "Kioku memory API origin. Probed for /health and /facts/count.",
    ),
    KOKORO_DASHBOARD_URL: serviceUrl(
      "https://kokoro.localhost",
      "Kokoro dashboard origin. Cockpit reads /api/ops/summary for pending\napprovals and failed routines/watchers (the bot itself has no HTTP surface).",
    ),
    KIZUNA_API_URL: serviceUrl(
      "https://api.kizuna.localhost",
      "Kizuna CRM API origin. Probed for /health, /oauth/google/status, and the\nGmail/Calendar sync states.",
    ),
    KANSOKU_API_URL: serviceUrl(
      "https://api.kansoku.localhost",
      "Kansoku observability API origin. Probed for /health and open error groups.",
    ),
    KAO_API_URL: serviceUrl(
      "https://api.kao.localhost",
      "Kao identity API origin. Probed for /health; grant status additionally\nneeds KAO_TOKEN.",
    ),

    KAO_TOKEN: z.string().optional().meta({
      doc: "Bearer for Kao's /grants read surface — lets the Kao card show per-grant\nstatus. Checked only at render: missing (or shorter than Kao's 16-char\nfloor) degrades to a \"grant visibility not configured\" warning card;\nCockpit never fails closed over it.",
      secret: true,
      sharedAllowed: true,
      crossService: true,
      group: "Kao (Google identity)",
    }),
  },
});

export type Config = EnvOutput<typeof envSpec>;
