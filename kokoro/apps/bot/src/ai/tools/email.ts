import { tool } from "ai";
import { z } from "zod";
import { listUnreadEmails, getEmailById, sendEmail } from "../../services/gmail";
import { logger } from "@kokoro/shared";

// ─── checkEmail ──────────────────────────────────────────────────────────────

export function createCheckEmailTool() {
  return tool({
    description:
      "Check Goshujin-sama's email. Lists unread emails or retrieves a specific email by ID.",
    inputSchema: z.object({
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum number of unread emails to fetch (1-100)"),
      emailId: z.string().optional().describe("Specific email ID to retrieve full details for"),
    }),
    execute: async ({ maxResults, emailId }) => {
      try {
        if (emailId) {
          logger.debug({ emailId }, "Tool: checkEmail (single)");
          const email = await getEmailById(emailId);
          if (!email) return { success: false, reason: "Email not found" };
          return { success: true, email };
        }

        logger.debug({ maxResults }, "Tool: checkEmail (list)");
        const emails = await listUnreadEmails(maxResults);
        return { success: true, count: emails.length, emails };
      } catch (error) {
        logger.error({ err: error }, "Tool: checkEmail failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Failed to check email",
        };
      }
    },
  });
}

// ─── sendEmail ───────────────────────────────────────────────────────────────

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
        logger.debug({ to, subject }, "Tool: sendEmail");
        const options = threadId || inReplyTo ? { threadId, inReplyTo } : undefined;
        const result = await sendEmail(to, subject, body, options);
        return { success: true, id: result.id, threadId: result.threadId };
      } catch (error) {
        logger.error({ err: error }, "Tool: sendEmail failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Failed to send email",
        };
      }
    },
  });
}
