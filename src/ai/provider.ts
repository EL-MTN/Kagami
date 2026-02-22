import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { config } from "../config.js";
import type { LanguageModelV1 } from "ai";

export function getModel(): LanguageModelV1 {
  if (config.LLM_PROVIDER === "anthropic") {
    return anthropic(config.LLM_MODEL);
  }
  return openai(config.LLM_MODEL);
}
