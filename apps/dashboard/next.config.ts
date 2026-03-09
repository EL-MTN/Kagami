import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mashiro/shared", "@mashiro/db"],
  serverExternalPackages: ["mongoose", "pino", "pino-pretty"],
};

export default nextConfig;
