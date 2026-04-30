import mongoose, { Schema, type Document } from "mongoose";
import crypto from "node:crypto";
import { removeImages, removeAudios } from "../gridfs";

export interface IMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  imageRef?: string;
  imageMimeType?: string;
  audioRef?: string;
  audioMimeType?: string;
  audioDurationSeconds?: number;
  toolCalls?: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result?: string;
  }>;
  timestamp: Date;
}

export interface IConversation extends Document {
  chatId: string;
  userId: string;
  platform: string;
  sessionId: string;
  status: "active" | "closed";
  closedAt?: Date;
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ["user", "assistant", "system", "tool"], required: true },
    content: { type: String, required: true },
    imageRef: { type: String },
    imageMimeType: { type: String },
    audioRef: { type: String },
    audioMimeType: { type: String },
    audioDurationSeconds: { type: Number },
    toolCalls: [
      {
        toolName: String,
        args: Schema.Types.Mixed,
        result: String,
      },
    ],
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const conversationSchema = new Schema<IConversation>(
  {
    chatId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    platform: { type: String, required: true },
    sessionId: { type: String, required: true, default: () => crypto.randomUUID() },
    status: { type: String, enum: ["active", "closed"], default: "active" },
    closedAt: { type: Date },
    messages: [messageSchema],
  },
  { timestamps: true },
);

conversationSchema.index({ chatId: 1, updatedAt: -1 });
conversationSchema.index({ chatId: 1, status: 1, updatedAt: -1 });
// Multi-platform scope: chatId can collide across platforms, so the
// session-lookup query is scoped by both. Without this index, the find in
// `getOrCreateSession` falls back to a less selective index.
conversationSchema.index({ chatId: 1, platform: 1, status: 1, updatedAt: -1 });

export const Conversation =
  (mongoose.models.Conversation as mongoose.Model<IConversation>) ??
  mongoose.model<IConversation>("Conversation", conversationSchema);

const IDLE_THRESHOLD_MS = 1 * 60 * 60 * 1000; // 1 hour

export interface SessionResult {
  conversation: IConversation;
  previouslyClosed?: IConversation;
}

export async function getOrCreateSession(
  chatId: string,
  userId: string,
  platform: string,
): Promise<SessionResult> {
  // Scope the lookup by platform so a chatId that happens to exist on two
  // platforms (e.g. a numeric Telegram id and an `imessage:`-prefixed
  // BlueBubbles chatGuid that share substring) cannot return the wrong
  // session. Telegram chatIds are always plain integers and iMessage
  // chatIds are always prefixed, so collision is unreachable in practice;
  // this is defense in depth and keeps the invariant clear.
  const active = await Conversation.findOne({
    chatId,
    platform,
    status: "active",
  }).sort({ updatedAt: -1 });

  if (active) {
    const idleMs = Date.now() - active.updatedAt.getTime();
    if (idleMs < IDLE_THRESHOLD_MS) {
      return { conversation: active };
    }

    // Close stale session
    active.status = "closed";
    active.closedAt = new Date();
    await active.save();

    // Create new session
    const convo = await Conversation.create({
      chatId,
      userId,
      platform,
      sessionId: crypto.randomUUID(),
      status: "active",
      messages: [],
    });

    return { conversation: convo, previouslyClosed: active };
  }

  // No active session — create new
  const convo = await Conversation.create({
    chatId,
    userId,
    platform,
    sessionId: crypto.randomUUID(),
    status: "active",
    messages: [],
  });

  return { conversation: convo };
}

export async function closeSession(convo: IConversation): Promise<void> {
  convo.status = "closed";
  convo.closedAt = new Date();
  await convo.save();
}

export async function appendMessage(convo: IConversation, message: IMessage): Promise<void> {
  convo.messages.push(message);
  await convo.save();
}

export async function getRecentMessages(chatId: string, limit = 40): Promise<IMessage[]> {
  const convo = await Conversation.findOne({
    chatId,
    status: "active",
  }).sort({ updatedAt: -1 });

  if (!convo) return [];

  return convo.messages.slice(-limit);
}

export interface OverflowResult {
  conversationId: string;
  overflow: IMessage[];
  total: number;
}

export async function getOverflowMessages(
  chatId: string,
  contextLimit = 40,
): Promise<OverflowResult | null> {
  const convo = await Conversation.findOne({
    chatId,
    status: "active",
  }).sort({ updatedAt: -1 });

  if (!convo || convo.messages.length <= contextLimit) return null;

  const overflowCount = convo.messages.length - contextLimit;
  return {
    conversationId: convo._id.toString(),
    overflow: convo.messages.slice(0, overflowCount),
    total: convo.messages.length,
  };
}

export async function clearConversation(chatId: string): Promise<void> {
  const convos = await Conversation.find({ chatId, status: "active" });
  const imageKeys = convos.flatMap((c) =>
    c.messages.filter((m) => m.imageRef).map((m) => m.imageRef!),
  );
  const audioKeys = convos.flatMap((c) =>
    c.messages.filter((m) => m.audioRef).map((m) => m.audioRef!),
  );
  await removeImages(imageKeys);
  await removeAudios(audioKeys);
  await Conversation.deleteMany({ chatId, status: "active" });
}

export async function trimConversation(conversationId: string, keep = 40): Promise<void> {
  const convo = await Conversation.findById(conversationId);
  if (!convo) return;

  if (convo.messages.length > keep) {
    const trimmed = convo.messages.slice(0, -keep);
    const imageKeys = trimmed.filter((m) => m.imageRef).map((m) => m.imageRef!);
    const audioKeys = trimmed.filter((m) => m.audioRef).map((m) => m.audioRef!);
    await removeImages(imageKeys);
    await removeAudios(audioKeys);
    convo.messages = convo.messages.slice(-keep);
    await convo.save();
  }
}

export async function cleanupOldConversations(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await Conversation.deleteMany({
    status: "closed",
    closedAt: { $lt: cutoff },
  });
  return result.deletedCount;
}
