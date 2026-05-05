import baseConfig from "@kokoro/eslint-config/base";
import nextPlugin from "@next/eslint-plugin-next";

export default [
  ...baseConfig,
  nextPlugin.configs.recommended,
  nextPlugin.configs["core-web-vitals"],
];
