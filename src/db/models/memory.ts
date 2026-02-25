import mongoose, { Schema, type Document } from "mongoose";

export interface IMemoryMetadata {
  chatId?: string;
  emotionalTone?: number;
  importance?: number;
  followUps?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IMemory extends Document {
  content: string;
  type: "fact" | "episode" | "milestone";
  source: string;
  embedding: number[];
  metadata: IMemoryMetadata;
}

const memorySchema = new Schema<IMemory>(
  {
    content: { type: String, required: true },
    type: { type: String, enum: ["fact", "episode", "milestone"], required: true },
    source: { type: String, required: true },
    embedding: { type: [Number], required: true },
    metadata: {
      chatId: { type: String },
      emotionalTone: { type: Number },
      importance: { type: Number },
      followUps: { type: [String] },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
    },
  },
  { timestamps: false },
);

memorySchema.index({ type: 1 });
memorySchema.index({ "metadata.chatId": 1 });
memorySchema.index({ "metadata.createdAt": -1 });

export const Memory = mongoose.model<IMemory>("Memory", memorySchema);
