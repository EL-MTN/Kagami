import { google } from "googleapis";
import { withFreshAuth } from "./google-auth";
import { KaoMisconfiguredError, KaoNoGrantError, KaoUnreachableError } from "./kao-client";
import { logger } from "@kokoro/shared";

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  isUnread: boolean;
  threadId: string;
}

export interface EmailDetail extends EmailSummary {
  body: string;
  messageId: string;
}

function getHeader(
  headers: { name?: string | null; value?: string | null }[],
  name: string,
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function listUnreadEmails(maxResults = 10): Promise<EmailSummary[]> {
  return withFreshAuth(async (auth) => {
    const gmail = google.gmail({ version: "v1", auth });

    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
      maxResults,
    });

    const messageIds = res.data.messages ?? [];
    if (messageIds.length === 0) return [];

    const emails = await Promise.all(
      messageIds.map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = detail.data.payload?.headers ?? [];
        return {
          id: detail.data.id!,
          from: getHeader(headers, "From"),
          subject: getHeader(headers, "Subject"),
          snippet: detail.data.snippet ?? "",
          date: getHeader(headers, "Date"),
          isUnread: (detail.data.labelIds ?? []).includes("UNREAD"),
          threadId: detail.data.threadId!,
        };
      }),
    );

    return emails;
  });
}

function extractPlainText(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: (typeof payload)[] | null;
}): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }

  return "";
}

function extractHtmlBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: (typeof payload)[] | null;
}): string {
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractHtmlBody(part);
      if (html) return html;
    }
  }

  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SendEmailResult {
  id: string;
  threadId: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: { threadId?: string; inReplyTo?: string },
): Promise<SendEmailResult> {
  return withFreshAuth(async (auth) => {
    const gmail = google.gmail({ version: "v1", auth });

    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
    const encodedBody = Buffer.from(body).toString("base64");

    const messageParts = ["MIME-Version: 1.0", `To: ${to}`, `Subject: ${encodedSubject}`];

    if (options?.inReplyTo) {
      messageParts.push(`In-Reply-To: ${options.inReplyTo}`);
      messageParts.push(`References: ${options.inReplyTo}`);
    }

    messageParts.push(
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodedBody,
    );
    const raw = Buffer.from(messageParts.join("\r\n")).toString("base64url");

    const requestBody: { raw: string; threadId?: string } = { raw };
    if (options?.threadId) {
      requestBody.threadId = options.threadId;
    }

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody,
    });

    logger.info({ to, subject, id: res.data.id }, "Email sent");

    return {
      id: res.data.id!,
      threadId: res.data.threadId!,
    };
  });
}

export async function getEmailById(messageId: string): Promise<EmailDetail | null> {
  try {
    return await withFreshAuth(async (auth) => {
      const gmail = google.gmail({ version: "v1", auth });
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const headers = detail.data.payload?.headers ?? [];
      const payload = detail.data.payload as Parameters<typeof extractPlainText>[0];
      let body = extractPlainText(payload);
      if (!body) {
        body = stripHtml(extractHtmlBody(payload));
      }

      return {
        id: detail.data.id!,
        from: getHeader(headers, "From"),
        subject: getHeader(headers, "Subject"),
        snippet: detail.data.snippet ?? "",
        date: getHeader(headers, "Date"),
        isUnread: (detail.data.labelIds ?? []).includes("UNREAD"),
        threadId: detail.data.threadId!,
        messageId: getHeader(headers, "Message-ID"),
        body: body.slice(0, 2000),
      };
    });
  } catch (error) {
    // Re-throw operator-actionable identity errors so the LLM/tool layer can
    // surface "re-consent required", "Kao misconfigured", or "Kao
    // unreachable" instead of silently returning "no email". A downed Kao
    // would otherwise produce an indefinite "no such email" for every call.
    // Per-message Gmail errors (the pre-existing contract) still resolve to
    // null.
    if (
      error instanceof KaoNoGrantError ||
      error instanceof KaoMisconfiguredError ||
      error instanceof KaoUnreachableError
    ) {
      throw error;
    }
    logger.error({ error, messageId }, "Failed to get email by ID");
    return null;
  }
}
