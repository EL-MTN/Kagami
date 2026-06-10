import { z } from "zod";
import { defineEnv, kansokuShipper, logging, type EnvOutput } from "@kagami/env";

/**
 * Kao API env spec — the single source of truth for this app's configuration.
 * `.env.example`, the docs/configuration.md table, and turbo.json env
 * declarations are all generated from it: edit here, then `npm run env:gen`.
 *
 * This module must stay a leaf (zod + @kagami/env only) so the workspace
 * generator can import it without booting the app.
 */

const base64Key32 = z.string().refine((s) => {
  try {
    return Buffer.from(s, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be a base64-encoded 32-byte key");

// Both public-facing URLs are rendered into anchor hrefs in the inline
// operator pages and composed with path suffixes (`${KAO_DASHBOARD_URL}/grants/:n`).
// Reject non-http(s) schemes (no `javascript:`) AND non-origin URLs (no path,
// query, or fragment) so composition can't produce a malformed href like
// `https://kao.localhost/foo?bar/grants/kokoro`. `new URL` always yields
// pathname '/' for an origin-only http(s) URL, so we only check against '/'.
const httpOrigin = z
  .string()
  .url()
  .refine((u) => {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      if (parsed.search !== "" || parsed.hash !== "") return false;
      if (parsed.pathname !== "/") return false;
      return true;
    } catch {
      return false;
    }
  }, "must be an http(s) origin with no path/query/fragment");

const kansoku = kansokuShipper();
const log = logging();

export const envSpec = defineEnv({
  service: "kao",
  component: "api",
  vars: {
    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI")
      .meta({
        doc: "MongoDB connection (`mongodb://` or `mongodb+srv://`).",
        example: "mongodb://127.0.0.1:27017/kao",
        crossService: true,
      }),
    KAO_DB_NAME: z.string().min(1).default("kao").meta({
      doc: "Database name.",
      crossService: true,
    }),

    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).meta({
      doc: "Single Google Cloud OAuth client (Web application type). Register exactly\none authorized redirect URI: ${KAO_PUBLIC_URL}/oauth/callback.\nKao's whole purpose is OAuth — these are required, not optional.",
      crossService: true,
    }),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).meta({
      doc: "Google OAuth client secret.",
      secret: true,
      sharedAllowed: false,
      crossService: true,
    }),

    KAO_PUBLIC_URL: httpOrigin.default("https://api.kao.localhost").meta({
      doc: "Public origin Google redirects back to. The callback path is fixed at\n/oauth/callback; the grant being authorized is carried in signed state,\nso only this one redirect URI needs registering in Google Cloud.",
      crossService: true,
    }),
    KAO_DASHBOARD_URL: httpOrigin.default("https://kao.localhost").meta({
      doc: "Where the operator's browser lands after consent succeeds. Distinct from\nKAO_PUBLIC_URL because the dashboard runs on a separate Portless name\n(kao.localhost vs api.kao.localhost). The OAuth success page links here.",
    }),

    KAO_ENCRYPTION_KEY: base64Key32.meta({
      doc: "Refresh tokens are AES-256-GCM encrypted at rest under this key.\nGenerate once with:\n  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      secret: true,
      sharedAllowed: false,
      crossService: true,
    }),

    KAO_TOKEN: z.string().min(16, "KAO_TOKEN must be at least 16 chars").meta({
      doc: "Bearer that sibling services must present to read /grants/* (token vend).\nKao holds the crown-jewel credential WITH send/write scopes, so unlike the\nother services' open-at-localhost resource routes, the vend surface is\nalways bearer-gated. Generate with:\n  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      secret: true,
      sharedAllowed: true,
      crossService: true,
    }),

    KAO_HOST: z.string().default("127.0.0.1").meta({
      doc: "Standalone fallback bind host. Portless injects PORT and proxies\nhttps://api.kao.localhost; these only matter running outside Portless.",
      standaloneOnly: true,
      group: "Standalone fallback",
    }),
    PORT: z.coerce.number().int().positive().max(65_535).default(4040).meta({
      doc: "Standalone fallback bind port (Portless injects its own otherwise).",
      standaloneOnly: true,
      group: "Standalone fallback",
    }),

    ...log.vars,
    ...kansoku.vars,
  },
});

export type Config = EnvOutput<typeof envSpec>;
