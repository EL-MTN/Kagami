import { tool } from "ai";
import { z } from "zod";
import { listEmails, getEmailById, getOwnerAddress, sendEmail } from "../../services/gmail";
import { logger } from "@kokoro/shared";
import { OWNER } from "../persona";

// ─── checkEmail ──────────────────────────────────────────────────────────────

export function createCheckEmailTool() {
  return tool({
    description: `Check ${OWNER}'s email. Lists unread emails by default, searches the mailbox when a query is given, or retrieves a specific email by ID.`,
    inputSchema: z.object({
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum number of emails to fetch (1-100)"),
      query: z
        .string()
        .optional()
        .describe(
          "Gmail search query (e.g. 'from:alice@x.com newer_than:7d', 'subject:invoice'). Omit to list unread.",
        ),
      emailId: z.string().optional().describe("Specific email ID to retrieve full details for"),
    }),
    execute: async ({ maxResults, query, emailId }) => {
      try {
        if (emailId) {
          logger.debug({ emailId }, "Tool: checkEmail (single)");
          const email = await getEmailById(emailId);
          if (!email) return { success: false, reason: "Email not found" };
          return { success: true, email };
        }

        logger.debug({ maxResults, query }, "Tool: checkEmail (list)");
        const emails = await listEmails(query ?? "is:unread", maxResults);
        return { success: true, count: emails.length, emails };
      } catch (error) {
        logger.error({ error: error }, "Tool: checkEmail failed");
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
    description: `Send an email on behalf of ${OWNER}. Direct sends are allowed ONLY to ${OWNER}'s own address with no cc/bcc (notes-to-self); anything externally visible is refused here — wrap it in requestConfirmation({ summary, action: { tool: "sendEmail", args } }) instead. Can reply to an existing thread by providing threadId and inReplyTo from checkEmail results.`,
    inputSchema: z.object({
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().min(1).describe("Email subject line"),
      body: z.string().min(1).describe("Plain text email body"),
      cc: z
        .array(z.string().email())
        .max(20)
        .optional()
        .describe("Optional cc recipients (always approval-gated)"),
      bcc: z
        .array(z.string().email())
        .max(20)
        .optional()
        .describe("Optional bcc recipients (always approval-gated)"),
      threadId: z
        .string()
        .optional()
        .describe("Gmail thread ID for replying to an existing thread"),
      inReplyTo: z.string().optional().describe("Message-ID header of the email being replied to"),
    }),
    execute: async ({ to, subject, body, cc, bcc, threadId, inReplyTo }) => {
      try {
        // Code-enforced gate (same pattern as the CRM writes): only a
        // note-to-self — addressed to the authenticated account itself, with
        // no other recipient on any line — may send without approval. The
        // gated dispatcher calls the service directly, so approved sends are
        // unaffected.
        const owner = await getOwnerAddress();
        const isSelfOnly =
          owner !== null && to.toLowerCase() === owner && !cc?.length && !bcc?.length;
        if (!isSelfOnly) {
          logger.warn(
            { to, owner },
            "Tool: sendEmail invoked directly for a non-self send — refusing",
          );
          return {
            success: false,
            reason:
              owner === null
                ? `could not verify the recipient as ${OWNER}'s own address — wrap the send in requestConfirmation({ summary, action: { tool: "sendEmail", args } })`
                : `sendEmail beyond ${OWNER}'s own address (${owner}) is approval-gated. Wrap it in requestConfirmation({ summary, action: { tool: "sendEmail", args } }) — direct invocation is refused.`,
          };
        }

        logger.debug({ to, subject }, "Tool: sendEmail (self)");
        const options = threadId || inReplyTo ? { threadId, inReplyTo } : undefined;
        const result = await sendEmail(to, subject, body, options);
        return { success: true, id: result.id, threadId: result.threadId };
      } catch (error) {
        logger.error({ error: error }, "Tool: sendEmail failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Failed to send email",
        };
      }
    },
  });
}
