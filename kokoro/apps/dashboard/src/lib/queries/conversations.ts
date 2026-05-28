import { Conversation } from "@kokoro/db";
import type { IMessage } from "@kokoro/db";
import { ensureDB } from "../db";

interface ConversationListItem {
  id: string;
  sessionId: string;
  chatId: string;
  platform: string;
  status: "active" | "closed";
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const PAGE_SIZE = 20;

interface ConversationListOptions {
  status?: "active" | "closed";
  /** Substring match against chatId. */
  search?: string;
}

export async function getConversationList(
  page = 1,
  options: ConversationListOptions = {},
): Promise<{ items: ConversationListItem[]; total: number; pageSize: number }> {
  await ensureDB();

  const skip = (page - 1) * PAGE_SIZE;

  const filter: Record<string, unknown> = {};
  if (options.status) filter.status = options.status;
  if (options.search) {
    filter.chatId = {
      $regex: options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    };
  }

  const [items, total] = await Promise.all([
    Conversation.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(PAGE_SIZE)
      .select("sessionId chatId platform status messages createdAt updatedAt")
      .lean(),
    Conversation.countDocuments(filter),
  ]);

  return {
    items: items.map((c) => ({
      id: c._id.toString(),
      sessionId: c.sessionId,
      chatId: c.chatId,
      platform: c.platform,
      status: c.status,
      messageCount: c.messages.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    total,
    pageSize: PAGE_SIZE,
  };
}

interface ConversationDetail {
  id: string;
  sessionId: string;
  chatId: string;
  platform: string;
  status: "active" | "closed";
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
}

export async function getConversationDetail(id: string): Promise<ConversationDetail | null> {
  await ensureDB();

  let convo;
  try {
    convo = await Conversation.findById(id).lean();
  } catch {
    return null;
  }
  if (!convo) return null;

  return {
    id: convo._id.toString(),
    sessionId: convo.sessionId,
    chatId: convo.chatId,
    platform: convo.platform,
    status: convo.status,
    messages: convo.messages,
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt,
    closedAt: convo.closedAt,
  };
}
