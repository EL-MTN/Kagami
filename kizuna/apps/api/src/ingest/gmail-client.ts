import type { GmailMessage } from "./parse-message.js";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  GoogleRequestTimeoutError,
  isAbortSignalTimeout,
} from "./google-timeout.js";

const BASE = "https://gmail.googleapis.com/gmail/v1";

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

// `getAccessToken` accepts `{ force }` so the client can recover from a
// Google-side revocation mid-cache-window. On a 401/403 the client clears
// its access-token cache (`force: true`) and retries once; if Google still
// rejects, the GmailHttpError(401) escapes and the worker maps it to
// `OAuthError('invalid_grant')` for the pause path.
export type AccessTokenGetter = (options?: { force?: boolean }) => Promise<string>;

export function makeGmailClient(getAccessToken: AccessTokenGetter): GmailClient {
  async function call<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    return doCall<T>(path, query, false);
  }

  async function doCall<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    force: boolean,
  ): Promise<T> {
    const token = await getAccessToken({ force });
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      sp.set(k, String(v));
    }
    const url = `${BASE}${path}${sp.size ? `?${sp.toString()}` : ""}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortSignalTimeout(err)) throw new GoogleRequestTimeoutError("gmail");
      throw err;
    }
    if ((res.status === 401 || res.status === 403) && !force) {
      // Google rejected the cached access token. Force Kao to bypass its
      // cache and re-derive from the refresh token, then retry exactly once.
      // If Google rejects the fresh token too, the second attempt's 401
      // escapes and the worker pauses on `invalid_grant`.
      return doCall<T>(path, query, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GmailHttpError(res.status, text);
    }
    return (await res.json()) as T;
  }

  return {
    getProfile: () => call<GmailProfile>("/users/me/profile"),
    listMessages: ({ q, pageToken, maxResults }) =>
      call<GmailListMessagesResp>("/users/me/messages", {
        q,
        pageToken,
        maxResults,
      }),
    getMessage: (id) => call<GmailMessage>(`/users/me/messages/${id}`, { format: "full" }),
    listHistory: ({ startHistoryId, pageToken, maxResults }) =>
      call<GmailHistoryResp>("/users/me/history", {
        startHistoryId,
        pageToken,
        maxResults,
        historyTypes: "messageAdded",
      }),
  };
}
