import type { GmailMessage } from './parse-message.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1';

export type GmailProfile = {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
};

export type GmailListMessagesResp = {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailHistoryRecord = {
  id?: string;
  messages?: { id: string }[];
  messagesAdded?: { message: { id: string; threadId?: string } }[];
  messagesDeleted?: { message: { id: string } }[];
};

export type GmailHistoryResp = {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
};

export type GmailClient = {
  getProfile(): Promise<GmailProfile>;
  listMessages(opts: {
    q?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailListMessagesResp>;
  getMessage(id: string): Promise<GmailMessage>;
  listHistory(opts: {
    startHistoryId: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailHistoryResp>;
};

export class GmailHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`gmail api ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export function makeGmailClient(
  getAccessToken: () => Promise<string>,
): GmailClient {
  async function call<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const token = await getAccessToken();
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      sp.set(k, String(v));
    }
    const url = `${BASE}${path}${sp.size ? `?${sp.toString()}` : ''}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GmailHttpError(res.status, text);
    }
    return (await res.json()) as T;
  }

  return {
    getProfile: () => call<GmailProfile>('/users/me/profile'),
    listMessages: ({ q, pageToken, maxResults }) =>
      call<GmailListMessagesResp>('/users/me/messages', {
        q,
        pageToken,
        maxResults,
      }),
    getMessage: (id) =>
      call<GmailMessage>(`/users/me/messages/${id}`, { format: 'full' }),
    listHistory: ({ startHistoryId, pageToken, maxResults }) =>
      call<GmailHistoryResp>('/users/me/history', {
        startHistoryId,
        pageToken,
        maxResults,
        historyTypes: 'messageAdded',
      }),
  };
}
