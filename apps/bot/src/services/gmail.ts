import { google } from "googleapis";
import { getGoogleAuth } from "./google-auth.js";
import { logger } from "@mashiro/shared";

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  isUnread: boolean;
}

export interface EmailDetail extends EmailSummary {
  body: string;
}

function getGmail() {
  return google.gmail({ version: "v1", auth: getGoogleAuth() });
}

function getHeader(
  headers: { name?: string | null; value?: string | null }[],
  name: string,
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function listUnreadEmails(maxResults = 10): Promise<EmailSummary[]> {
  const gmail = getGmail();

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
      };
    }),
  );

  return emails;
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

export interface SendEmailResult {
  id: string;
  threadId: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<SendEmailResult> {
  const gmail = getGmail();

  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  const raw = Buffer.from(messageParts.join("\r\n")).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  logger.info({ to, subject, id: res.data.id }, "Email sent");

  return {
    id: res.data.id!,
    threadId: res.data.threadId!,
  };
}

export async function getEmailById(messageId: string): Promise<EmailDetail | null> {
  const gmail = getGmail();

  try {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = detail.data.payload?.headers ?? [];
    const body = extractPlainText(detail.data.payload as Parameters<typeof extractPlainText>[0]);

    return {
      id: detail.data.id!,
      from: getHeader(headers, "From"),
      subject: getHeader(headers, "Subject"),
      snippet: detail.data.snippet ?? "",
      date: getHeader(headers, "Date"),
      isUnread: (detail.data.labelIds ?? []).includes("UNREAD"),
      body: body.slice(0, 2000),
    };
  } catch (error) {
    logger.error({ error, messageId }, "Failed to get email by ID");
    return null;
  }
}
