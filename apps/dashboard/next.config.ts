import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mashiro/shared", "@mashiro/db"],
  serverExternalPackages: ["mongoose", "pino", "pino-pretty"],
  webpack: (config: { resolve?: { extensionAlias?: Record<string, string[]> } }) => {
    // Internal packages use .js extensions in imports (TS ESM convention).
    // Tell webpack to try .ts before .js when resolving .js imports.
    config.resolve = {
      ...config.resolve,
      extensionAlias: {
        ...config.resolve?.extensionAlias,
        ".js": [".ts", ".tsx", ".js"],
      },
    };
    return config;
  },
};

export default nextConfig;
