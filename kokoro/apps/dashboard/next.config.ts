import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages aren't pre-built; let Next bundle their TS source.
  transpilePackages: ["@kokoro/shared", "@kokoro/db"],
  // Native bindings + dynamic loaders that don't bundle cleanly.
  serverExternalPackages: ["mongoose", "pino", "pino-pretty"],
};

export default nextConfig;
