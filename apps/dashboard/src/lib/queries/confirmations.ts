import {
  PendingConfirmation,
  type PendingConfirmationOrigin,
  type PendingConfirmationStatus,
} from "@mashiro/db";
import { ensureDB } from "../db";

export interface ConfirmationListItem {
  id: string;
  chatId: string;
  summary: string;
  tool: string;
  args: Record<string, unknown>;
  status: PendingConfirmationStatus;
  origin: PendingConfirmationOrigin;
  originRef: string | null;
  resultText: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

interface ConfirmationDoc {
  _id: { toString(): string };
  chatId: string;
  summary: string;
  action: { tool: string; args: Record<string, unknown> };
  status: PendingConfirmationStatus;
  origin: PendingConfirmationOrigin;
  originRef?: string;
  resultText?: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;
}

function toItem(c: ConfirmationDoc): ConfirmationListItem {
  return {
    id: c._id.toString(),
    chatId: c.chatId,
    summary: c.summary,
    tool: c.action.tool,
    args: c.action.args,
    status: c.status,
    origin: c.origin,
    originRef: c.originRef ?? null,
    resultText: c.resultText ?? null,
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
  };
}

export async function getPendingConfirmationList(): Promise<ConfirmationListItem[]> {
  await ensureDB();
  const items = await PendingConfirmation.find({
    status: "pending",
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<ConfirmationDoc[]>();
  return items.map(toItem);
}

export async function getRecentResolvedConfirmations(limit = 50): Promise<ConfirmationListItem[]> {
  await ensureDB();
  const items = await PendingConfirmation.find({
    status: { $in: ["approved", "denied", "cancelled", "expired"] },
  })
    .sort({ resolvedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean<ConfirmationDoc[]>();
  return items.map(toItem);
}

export async function getPendingConfirmationCount(): Promise<number> {
  await ensureDB();
  return PendingConfirmation.countDocuments({
    status: "pending",
    expiresAt: { $gt: new Date() },
  });
}
