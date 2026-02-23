import { tool } from "ai";
import { z } from "zod";
import { generateImage } from "../../context/generator.js";
import type { PlatformAdapter } from "../../platform/types.js";
import { logger } from "../../utils/logger.js";

const APPEARANCE_PREFIX =
  "Generate a realistic smartphone photo of the same woman shown in the reference images. She has long blonde hair and amber eyes — match her face, hair color, and features exactly to the face/identity references. The photo must look like it was taken with a phone camera — natural lighting, slight depth of field, realistic perspective. No studio lighting, no artificial poses, no illustration style. CAMERA LOGIC: For selfies, one arm extends toward the camera (holding the phone that is taking the photo) — the phone itself is behind the camera and NOT visible in the frame. Only the extended arm/hand is seen, cropped at the edge. The other hand is free for posing or holding scene-relevant items. For mirror selfies, the phone is visible in the reflection only. For non-selfie shots, both hands are free. Never show a phone screen or a second phone anywhere in the image. ";

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
      caption: z.string().optional().describe("Caption to send with the photo"),
      aspectRatio: z
        .enum(["1:1", "3:4", "4:3", "9:16", "16:9"])
        .optional()
        .describe("Photo aspect ratio, defaults to 3:4 portrait"),
    }),
    execute: async ({ description, caption, aspectRatio }) => {
      const prompt = buildImagePrompt(description);

      try {
        const image = await generateImage({
          prompt,
          aspectRatio: aspectRatio || "3:4",
        });

        await adapter.sendPhotoBuffer(chatId, image.buffer, caption);

        return { sent: true, caption };
      } catch (err) {
        logger.error({ err, description }, "Image generation failed");
        return { sent: false, reason: "Image generation failed" };
      }
    },
  });
}
