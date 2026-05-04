import type {
  GmailClient,
  GmailHistoryRecord,
  GmailHistoryResp,
  GmailListMessagesResp,
  GmailProfile,
} from '../../src/ingest/gmail-client.js';
import { GmailHttpError } from '../../src/ingest/gmail-client.js';
import type { GmailMessage } from '../../src/ingest/parse-message.js';

export class FakeGmailClient implements GmailClient {
  readonly messages = new Map<string, GmailMessage>();
  profileHistoryId = '1000';
  email = 'me@example.com';
  historyEvents: GmailHistoryRecord[] = [];
  fail401AtMessageId: string | null = null;

  add(msg: GmailMessage): void {
    this.messages.set(msg.id, msg);
  }

  addAddedHistory(messageId: string): void {
    this.historyEvents.push({ messagesAdded: [{ message: { id: messageId } }] });
  }

  async getProfile(): Promise<GmailProfile> {
    return {
      emailAddress: this.email,
      historyId: this.profileHistoryId,
    };
  }

  async listMessages(_opts: {
    q?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailListMessagesResp> {
    return {
      messages: [...this.messages.keys()].map((id) => ({ id })),
    };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    if (this.fail401AtMessageId === id) {
      throw new GmailHttpError(401, '{"error":"invalid_grant"}');
    }
    const m = this.messages.get(id);
    if (!m) throw new GmailHttpError(404, 'not found');
    return m;
  }

  async listHistory(_opts: {
    startHistoryId: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailHistoryResp> {
    return {
      history: this.historyEvents,
      historyId: this.profileHistoryId,
    };
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

export function buildPlainMessage(opts: {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: string;
  listUnsubscribe?: string;
  cc?: string;
}): GmailMessage {
  const headers = [
    { name: 'From', value: opts.from },
    { name: 'To', value: opts.to },
    { name: 'Subject', value: opts.subject },
    { name: 'Date', value: opts.date ?? 'Thu, 15 Jan 2026 09:30:00 -0500' },
  ];
  if (opts.cc) headers.push({ name: 'Cc', value: opts.cc });
  if (opts.listUnsubscribe) {
    headers.push({ name: 'List-Unsubscribe', value: opts.listUnsubscribe });
  }
  return {
    id: opts.id,
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: b64(opts.body) },
    },
  };
}
