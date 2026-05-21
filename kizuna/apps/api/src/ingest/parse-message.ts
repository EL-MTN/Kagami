// Pure parser: Gmail "users.messages.get?format=full" JSON → normalized record.
// No I/O; deterministic; fixture-tested.

type GmailHeader = { name: string; value: string };

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
  labelIds?: string[];
};

export type ParsedAddress = { name: string | null; email: string };

type ParsedAttachment = {
  name: string;
  mimeType: string | null;
  size: number | null;
  ref: string | null; // gmail attachment ID, scoped to the message
};

export type ParsedMessage = {
  id: string;
  occurredAt: Date;
  subject: string;
  bodyText: string;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  hasListUnsubscribe: boolean;
  attachments: ParsedAttachment[];
};

const ADDRESS_RE = /^\s*(?:"?([^"<]*?)"?\s*<)?([^<>\s,;]+@[^<>\s,;]+)>?\s*$/;

export function parseAddress(raw: string): ParsedAddress | null {
  if (!raw) return null;
  const m = raw.match(ADDRESS_RE);
  if (!m || !m[2]) return null;
  const name = (m[1] ?? "").trim() || null;
  return { name, email: m[2].toLowerCase() };
}

// Address lists may have nested commas inside quoted names; this is a
// pragmatic splitter that handles the common cases (quoted strings + < >).
export function parseAddressList(raw: string | undefined): ParsedAddress[] {
  if (!raw) return [];
  const out: ParsedAddress[] = [];
  let depth = 0;
  let inQuote = false;
  let buf = "";
  for (const ch of raw) {
    if (ch === '"' && depth === 0) {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (inQuote) {
      buf += ch;
      continue;
    }
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0) {
      const piece = buf.trim();
      if (piece) {
        const a = parseAddress(piece);
        if (a) out.push(a);
      }
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last) {
    const a = parseAddress(last);
    if (a) out.push(a);
  }
  return out;
}

function headerMap(headers: GmailHeader[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!headers) return m;
  for (const h of headers) {
    m.set(h.name.toLowerCase(), h.value);
  }
  return m;
}

function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function findPartByMime(payload: GmailPart | undefined, mimeType: string): GmailPart | null {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data && !payload.filename) {
    return payload;
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const found = findPartByMime(p, mimeType);
      if (found) return found;
    }
  }
  return null;
}

function collectAttachments(
  payload: GmailPart | undefined,
  out: ParsedAttachment[] = [],
): ParsedAttachment[] {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      name: payload.filename,
      mimeType: payload.mimeType ?? null,
      size: payload.body.size ?? null,
      ref: payload.body.attachmentId,
    });
  }
  if (payload.parts) {
    for (const p of payload.parts) collectAttachments(p, out);
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:p|br|li|div|h[1-6]|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBody(payload: GmailPart | undefined): string {
  // Prefer text/plain per spec; fall back to text/html stripped.
  const plain = findPartByMime(payload, "text/plain");
  if (plain?.body?.data) {
    return decodeBase64Url(plain.body.data).toString("utf8");
  }
  // Top-level body (non-multipart messages).
  if (payload?.mimeType?.startsWith("text/plain") && payload.body?.data && !payload.filename) {
    return decodeBase64Url(payload.body.data).toString("utf8");
  }
  const html = findPartByMime(payload, "text/html");
  if (html?.body?.data) {
    return stripHtml(decodeBase64Url(html.body.data).toString("utf8"));
  }
  if (payload?.mimeType?.startsWith("text/html") && payload.body?.data && !payload.filename) {
    return stripHtml(decodeBase64Url(payload.body.data).toString("utf8"));
  }
  return "";
}

export function parseGmailMessage(msg: GmailMessage): ParsedMessage {
  const h = headerMap(msg.payload?.headers);
  const subject = h.get("subject") ?? "(no subject)";
  const from = parseAddress(h.get("from") ?? "");
  const to = parseAddressList(h.get("to"));
  const cc = parseAddressList(h.get("cc"));
  const bcc = parseAddressList(h.get("bcc"));
  const hasListUnsubscribe = h.has("list-unsubscribe");
  const dateHeader = h.get("date");
  let occurredAt: Date | null = null;
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!Number.isNaN(d.getTime())) occurredAt = d;
  }
  if (!occurredAt && msg.internalDate) {
    const ms = Number(msg.internalDate);
    if (Number.isFinite(ms)) occurredAt = new Date(ms);
  }
  if (!occurredAt) occurredAt = new Date();

  return {
    id: msg.id,
    occurredAt,
    subject,
    bodyText: extractBody(msg.payload),
    from,
    to,
    cc,
    bcc,
    hasListUnsubscribe,
    attachments: collectAttachments(msg.payload),
  };
}

export function senderDomain(addr: ParsedAddress | null): string | null {
  if (!addr) return null;
  const at = addr.email.lastIndexOf("@");
  if (at < 0) return null;
  return addr.email.slice(at + 1).toLowerCase();
}
