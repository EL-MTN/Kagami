import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@kokoro/shared", "@kokoro/db"],
  serverExternalPackages: ["mongoose", "pino", "pino-pretty"],
};

export default nextConfig;
