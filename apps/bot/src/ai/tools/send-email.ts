import { tool } from "ai";
import { z } from "zod";
import { sendEmail } from "../../services/gmail";
import { logger } from "@mashiro/shared";

export function createSendEmailTool() {
  return tool({
    description:
      "Send an email on behalf of Goshujin-sama. Can also reply to an existing email thread by providing threadId and inReplyTo from checkEmail results.",
    inputSchema: z.object({
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().min(1).describe("Email subject line"),
      body: z.string().min(1).describe("Plain text email body"),
      threadId: z
        .string()
        .optional()
        .describe("Gmail thread ID for replying to an existing thread"),
      inReplyTo: z.string().optional().describe("Message-ID header of the email being replied to"),
    }),
    execute: async ({ to, subject, body, threadId, inReplyTo }) => {
      try {
        logger.info({ to, subject }, "Tool: sendEmail");
        const options = threadId || inReplyTo ? { threadId, inReplyTo } : undefined;
        const result = await sendEmail(to, subject, body, options);
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
