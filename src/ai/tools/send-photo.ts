import { tool } from "ai";
import { z } from "zod";
import { generateImage } from "../../media/generator.js";
import { MediaAsset } from "../../db/models/media-asset.js";
import type { PlatformAdapter } from "../../platform/types.js";
import { logger } from "../../utils/logger.js";
import crypto from "node:crypto";

const APPEARANCE_PREFIX =
  "Generate a photo of the same woman shown in the reference images. She has long blonde hair and amber eyes — match her face, hair color, and features exactly to the references. ";

function buildImagePrompt(description: string): string {
  return APPEARANCE_PREFIX + "Scene: " + description;
}

export function createSendPhotoTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Generate and send a photo/selfie. Use when the conversation naturally calls for a picture. Provide a vivid scene description — the image will be AI-generated to match. Don't force it.",
    parameters: z.object({
      description: z
        .string()
        .describe(
          "Vivid scene description for the photo, e.g. 'selfie at a cozy coffee shop, warm lighting, wearing a cream sweater, latte in hand'",
        ),
      caption: z
        .string()
        .optional()
        .describe("Caption to send with the photo"),
      aspectRatio: z
        .enum(["1:1", "3:4", "4:3", "9:16", "16:9"])
        .optional()
        .describe("Photo aspect ratio, defaults to 3:4 portrait"),
    }),
    execute: async ({ description, caption, aspectRatio }) => {
      const prompt = buildImagePrompt(description);
      const promptHash = crypto
        .createHash("sha256")
        .update(prompt)
        .digest("hex");

      // Check if we have a cached Telegram file_id for this exact prompt
      const cached = await MediaAsset.findOne({ promptHash, telegramFileId: { $exists: true, $ne: null } });
      if (cached?.telegramFileId) {
        logger.debug({ promptHash }, "Sending cached photo via file_id");
        await adapter.sendPhoto(chatId, { fileId: cached.telegramFileId }, caption);
        return { sent: true, cached: true, caption };
      }

      try {
        const image = await generateImage({
          prompt,
          aspectRatio: aspectRatio || "3:4",
        });

        const fileId = await adapter.sendPhotoBuffer(chatId, image.buffer, caption);

        // Cache the Telegram file_id for future reuse
        if (fileId) {
          await MediaAsset.updateOne(
            { promptHash },
            { $set: { telegramFileId: fileId } },
            { upsert: false },
          );
        }

        return { sent: true, cached: false, caption };
      } catch (err) {
        logger.error({ err, description }, "Image generation failed");
        return { sent: false, reason: "Image generation failed" };
      }
    },
  });
}
