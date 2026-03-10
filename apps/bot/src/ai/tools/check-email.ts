import { tool } from "ai";
import { z } from "zod";
import { listUnreadEmails, getEmailById } from "../../services/gmail";
import { logger } from "@mashiro/shared";

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
          logger.info({ emailId }, "Tool: checkEmail (single)");
          const email = await getEmailById(emailId);
          if (!email) return { success: false, reason: "Email not found" };
          return { success: true, email };
        }

        logger.info({ maxResults }, "Tool: checkEmail (list)");
        const emails = await listUnreadEmails(maxResults);
        return { success: true, count: emails.length, emails };
      } catch (error) {
        logger.error({ error }, "Tool: checkEmail failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Failed to check email",
        };
      }
    },
  });
}
