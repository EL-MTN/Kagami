import mongoose, { Schema, type Document } from "mongoose";

export interface IMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  imageBase64?: string;
  imageMimeType?: string;
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
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ["user", "assistant", "system", "tool"], required: true },
    content: { type: String, required: true },
    imageBase64: { type: String },
    imageMimeType: { type: String },
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
    messages: [messageSchema],
  },
  { timestamps: true },
);

conversationSchema.index({ chatId: 1, updatedAt: -1 });

export const Conversation = mongoose.model<IConversation>("Conversation", conversationSchema);

export async function getOrCreateConversation(
  chatId: string,
  userId: string,
  platform: string,
): Promise<IConversation> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let convo = await Conversation.findOne({
    chatId,
    createdAt: { $gte: today },
  });

  if (!convo) {
    convo = await Conversation.create({
      chatId,
      userId,
      platform,
      messages: [],
    });
  }

  return convo;
}

export async function appendMessage(convo: IConversation, message: IMessage): Promise<void> {
  convo.messages.push(message);
  await convo.save();
}

export async function getRecentMessages(chatId: string, limit = 40): Promise<IMessage[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const convo = await Conversation.findOne({
    chatId,
    createdAt: { $gte: today },
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const convo = await Conversation.findOne({
    chatId,
    createdAt: { $gte: today },
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await Conversation.deleteMany({ chatId, createdAt: { $gte: today } });
}

export async function trimConversation(conversationId: string, keep = 40): Promise<void> {
  const convo = await Conversation.findById(conversationId);
  if (!convo) return;

  if (convo.messages.length > keep) {
    convo.messages = convo.messages.slice(-keep);
    await convo.save();
  }
}
