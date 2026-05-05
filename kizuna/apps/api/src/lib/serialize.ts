import { Types } from "mongoose";

const oidString = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Types.ObjectId) return v.toHexString();
  if (typeof v === "string") return v;
  return null;
};

const handlesToObject = (h: unknown): Record<string, string> => {
  if (!h) return {};
  if (h instanceof Map) return Object.fromEntries(h) as Record<string, string>;
  if (typeof h === "object") return h as Record<string, string>;
  return {};
};

type AnyDoc = Record<string, unknown>;

export function serializePerson(d: AnyDoc | null | undefined) {
  if (!d) return null;
  return {
    id: oidString(d._id),
    displayName: d.displayName ?? null,
    primaryEmail: d.primaryEmail ?? null,
    primaryOrgId: oidString(d.primaryOrgId),
    relationship: d.relationship ?? null,
    firstSeen: d.firstSeen ?? null,
    lastInteractionAt: d.lastInteractionAt ?? null,
    emails: d.emails ?? [],
    phones: d.phones ?? [],
    handles: handlesToObject(d.handles),
    tags: d.tags ?? [],
    birthday: d.birthday ?? null,
    notes: d.notes ?? null,
    suppressReingest: d.suppressReingest ?? false,
    source: d.source,
    sourceVersion: d.sourceVersion ?? null,
    deletedAt: d.deletedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function serializeOrganization(d: AnyDoc | null | undefined) {
  if (!d) return null;
  return {
    id: oidString(d._id),
    name: d.name ?? null,
    domain: d.domain ?? null,
    website: d.website ?? null,
    industry: d.industry ?? null,
    notes: d.notes ?? null,
    source: d.source,
    sourceVersion: d.sourceVersion ?? null,
    deletedAt: d.deletedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function serializeInteraction(d: AnyDoc | null | undefined) {
  if (!d) return null;
  const sourceRef = d.sourceRef as { provider?: string; id?: string } | null | undefined;
  return {
    id: oidString(d._id),
    occurredAt: d.occurredAt,
    channel: d.channel,
    title: d.title,
    body: d.body ?? "",
    sourceRef:
      sourceRef && sourceRef.id ? { provider: sourceRef.provider, id: sourceRef.id } : null,
    participants: ((d.participants as AnyDoc[] | undefined) ?? []).map((p) => ({
      personId: oidString(p.personId),
      role: p.role,
    })),
    location: d.location ?? null,
    attachments: ((d.attachments as AnyDoc[] | undefined) ?? []).map((a) => ({
      name: a.name,
      mimeType: a.mimeType ?? null,
      size: a.size ?? null,
      ref: a.ref ?? null,
    })),
    context: d.context ?? [],
    status: d.status,
    source: d.source,
    sourceVersion: d.sourceVersion ?? null,
    deletedAt: d.deletedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function serializeFollowup(d: AnyDoc | null | undefined) {
  if (!d) return null;
  return {
    id: oidString(d._id),
    personId: oidString(d.personId),
    direction: d.direction,
    dueAt: d.dueAt ?? null,
    status: d.status,
    reason: d.reason,
    sourceInteractionId: oidString(d.sourceInteractionId),
    source: d.source,
    sourceVersion: d.sourceVersion ?? null,
    deletedAt: d.deletedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
