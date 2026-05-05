import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";
import baseConfig from "./base.js";

export default tseslint.config(
  ...baseConfig,
  {
    ignores: [".next/", "next-env.d.ts"],
  },
  {
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
);
