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

export type Channel =
  | 'email'
  | 'calendar'
  | 'in_person'
  | 'call'
  | 'message'
  | 'manual';

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
  status: 'active' | 'cancelled';
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Followup = {
  id: string;
  personId: string;
  direction: 'i_owe' | 'they_owe';
  dueAt: string | null;
  status: 'open' | 'done' | 'snoozed' | 'dismissed';
  reason: string;
  sourceInteractionId: string | null;
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
};

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
  status?: 'active' | 'cancelled' | 'any';
  source?: string;
  includeTombstoned?: boolean;
};

export type ListFollowupsQuery = {
  limit?: number;
  cursor?: string;
  personId?: string;
  direction?: 'i_owe' | 'they_owe';
  status?: 'open' | 'done' | 'snoozed' | 'dismissed';
  dueBefore?: string;
  dueAfter?: string;
  includeTombstoned?: boolean;
};

export type ListOrganizationsQuery = {
  limit?: number;
  cursor?: string;
  query?: string;
  domain?: string;
  source?: string;
  includeTombstoned?: boolean;
};
