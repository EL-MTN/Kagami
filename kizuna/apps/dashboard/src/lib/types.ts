// Mirrors the API response shapes from api/src/lib/serialize.ts.
// Keep in sync with that file when shapes change.

export type ListResp<T> = {
  items: T[];
  nextCursor?: string;
};

export type Person = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  primaryOrgId: string | null;
  relationship: string | null;
  firstSeen: string | null;
  lastInteractionAt: string | null;
  emails: string[];
  phones: string[];
  handles: Record<string, string>;
  tags: string[];
  birthday: string | null;
  notes: string | null;
  suppressReingest: boolean;
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Organization = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  notes: string | null;
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Channel = "email" | "calendar" | "in_person" | "call" | "message" | "manual";

export type Interaction = {
  id: string;
  occurredAt: string;
  channel: Channel;
  title: string;
  body: string;
  sourceRef: { provider: string; id: string } | null;
  participants: { personId: string; role: string }[];
  location: string | null;
  attachments: {
    name: string;
    mimeType: string | null;
    size: number | null;
    ref: string | null;
  }[];
  context: string[];
  status: "active" | "cancelled";
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FollowupDirection = "i_owe" | "they_owe";
export type FollowupStatus = "open" | "done" | "snoozed" | "dismissed";

export type Followup = {
  id: string;
  personId: string;
  direction: FollowupDirection;
  dueAt: string | null;
  status: FollowupStatus;
  reason: string;
  sourceInteractionId: string | null;
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type DigestPerson = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
};

export type DigestFollowup = Followup & { person: DigestPerson | null };

export type Digest = {
  window: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  overdue: DigestFollowup[];
  upcoming: DigestFollowup[];
};

export type FollowupUpdateBody = {
  status: FollowupStatus;
  dueAt?: string;
  reason?: string;
};

export type ListPeopleQuery = {
  limit?: number;
  cursor?: string;
  query?: string;
  orgId?: string;
  tag?: string[];
  lastInteractionBefore?: string;
  lastInteractionAfter?: string;
  hasOpenFollowup?: boolean;
  source?: string;
  includeTombstoned?: boolean;
  sort?: "_id:-1" | "lastInteractionAt:-1";
};

export type ContextRow = { tag: string; count: number };
export type ListContextsQuery = { personId?: string; limit?: number };

export type ListInteractionsQuery = {
  limit?: number;
  cursor?: string;
  personId?: string;
  orgId?: string;
  context?: string;
  channel?: string;
  occurredBefore?: string;
  occurredAfter?: string;
  query?: string;
  status?: "active" | "cancelled" | "any";
  source?: string;
  includeTombstoned?: boolean;
  sort?: "_id:-1" | "occurredAt:-1";
};

export type ListFollowupsQuery = {
  limit?: number;
  cursor?: string;
  personId?: string;
  direction?: FollowupDirection;
  status?: FollowupStatus;
  dueBefore?: string;
  dueAfter?: string;
  includeTombstoned?: boolean;
  sort?: "_id:-1" | "duePriority:1";
};

export type OAuthStatus =
  | { granted: false }
  | { granted: true; scopes: string[]; grantedAt: string };

export type SyncState = {
  provider: "gmail" | "gcal";
  historyId: string | null;
  syncToken: string | null;
  lastRunAt: string | null;
  errorCount: number;
  lastError: string | null;
  pausedAt: string | null;
};

export type RunSyncResult = {
  status: "ok" | "paused" | "no_grant" | "error";
  fetched: number;
  inserted: number;
  skippedExisting: number;
  skippedNewsletter: number;
  errors: number;
  historyIdAfter: string | null;
  message?: string;
};

export type RunCalendarSyncResult = {
  status: "ok" | "paused" | "no_grant" | "error";
  fetched: number;
  upserted: number;
  cancelled: number;
  errors: number;
  syncTokenAfter: string | null;
  resyncedFromBootstrap: boolean;
  message?: string;
};

export type ListOrganizationsQuery = {
  limit?: number;
  cursor?: string;
  query?: string;
  domain?: string;
  source?: string;
  includeTombstoned?: boolean;
};
