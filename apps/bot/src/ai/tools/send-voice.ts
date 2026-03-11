import { tool } from "ai";
import { z } from "zod";
import { generateVoice } from "../../tts/generator";
import type { PlatformAdapter } from "@mashiro/shared";
import { logger } from "@mashiro/shared";

export function createSendVoiceTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Send a voice message. Use when a moment genuinely calls for audio — emotional emphasis, a whisper, a laugh, singing, teasing, or when asked. Write the text as natural spoken words, not a transcript of a text message.",
    inputSchema: z.object({
      text: z.string().describe("What to say out loud — write it naturally as spoken words"),
    }),
    execute: async ({ text }) => {
      try {
        const audio = await generateVoice({ text });
        await adapter.sendVoiceBuffer(chatId, audio.buffer, audio.durationSeconds);
        return { sent: true };
      } catch (err) {
        logger.error({ err, text: text.slice(0, 100) }, "Voice generation failed");
        return { sent: false, reason: "Voice generation failed" };
      }
    },
  });
}
