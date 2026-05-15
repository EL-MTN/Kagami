import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages aren't pre-built; let Next bundle their TS source.
  // `@kagami/logger` is pulled in via `@kokoro/shared` → `@kokoro/db` and
  // uses NodeNext `./foo.js` self-imports that Next's bundler can't
  // resolve unless the package is transpiled here.
  transpilePackages: ["@kokoro/shared", "@kokoro/db", "@kagami/logger"],
  // Native bindings + dynamic loaders that don't bundle cleanly.
  serverExternalPackages: ["mongoose", "pino", "pino-pretty"],
};

export default nextConfig;
