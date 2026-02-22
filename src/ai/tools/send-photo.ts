import { tool } from "ai";
import { z } from "zod";
import { selectPhoto } from "../../media/selector.js";
import type { PlatformAdapter } from "../../platform/types.js";
import { logger } from "../../utils/logger.js";

export function createSendPhotoTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Send a contextual photo/selfie. Use when the conversation naturally calls for a picture — e.g. talking about an outfit, mood, activity. Don't force it.",
    parameters: z.object({
      mood: z
        .string()
        .optional()
        .describe("Current mood: happy, cozy, flirty, sleepy, etc."),
      category: z
        .string()
        .optional()
        .describe("Photo category: selfies, outfits, mood, reactions"),
      context: z
        .string()
        .optional()
        .describe("What the photo is about, e.g. 'gym selfie', 'cozy night'"),
      caption: z
        .string()
        .optional()
        .describe("Caption to send with the photo"),
    }),
    execute: async ({ mood, category, context, caption }) => {
      const photo = await selectPhoto({ mood, category, context });
      if (!photo) {
        logger.debug("No matching photo found");
        return { sent: false, reason: "No matching photo available" };
      }

      const fileId = await adapter.sendPhoto(
        chatId,
        photo.telegramFileId
          ? { fileId: photo.telegramFileId }
          : { path: photo.filePath },
        caption,
      );

      // Cache the file ID for future use
      if (fileId && !photo.telegramFileId) {
        const { MediaAsset } = await import("../../db/models/media-asset.js");
        await MediaAsset.updateOne(
          { _id: photo.id },
          { telegramFileId: fileId },
        );
      }

      return { sent: true, photoId: photo.id, caption };
    },
  });
}
