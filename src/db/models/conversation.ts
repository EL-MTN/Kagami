import mongoose, { Schema, type Document } from "mongoose";

export interface IMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
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

export const Conversation = mongoose.model<IConversation>(
  "Conversation",
  conversationSchema,
);

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

export async function appendMessage(
  convo: IConversation,
  message: IMessage,
): Promise<void> {
  convo.messages.push(message);
  await convo.save();
}

export async function getRecentMessages(
  chatId: string,
  limit = 50,
): Promise<IMessage[]> {
  const convos = await Conversation.find({ chatId })
    .sort({ updatedAt: -1 })
    .limit(3);

  const allMessages = convos.flatMap((c) => c.messages);
  allMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return allMessages.slice(-limit);
}
