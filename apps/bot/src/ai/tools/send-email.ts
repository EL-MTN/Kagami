import { tool } from "ai";
import { z } from "zod";
import { sendEmail } from "../../services/gmail.js";
import { logger } from "@mashiro/shared";

export function createSendEmailTool() {
  return tool({
    description: "Send an email on behalf of Goshujin-sama.",
    parameters: z.object({
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().min(1).describe("Email subject line"),
      body: z.string().min(1).describe("Plain text email body"),
    }),
    execute: async ({ to, subject, body }) => {
      try {
        logger.info({ to, subject }, "Tool: sendEmail");
        const result = await sendEmail(to, subject, body);
        return { success: true, id: result.id, threadId: result.threadId };
      } catch (error) {
        logger.error({ error }, "Tool: sendEmail failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Failed to send email",
        };
      }
    },
  });
}
