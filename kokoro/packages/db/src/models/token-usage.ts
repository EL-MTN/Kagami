import mongoose, { Schema, type Document } from "mongoose";

export type UsageCategory =
  | "conversation"
  | "proactive"
  | "routine"
  | "watcher"
  | "curation"
  | "image-selection"
  | "image-generation"
  | "tts-generation"
  | "stt-transcription";

export interface ITokenUsage extends Document {
  timestamp: Date;
  category: UsageCategory;
  modelName: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  metadata?: {
    chatId?: string;
    sessionId?: string;
    routineId?: string;
    watcherId?: string;
    toolCalls?: number;
    steps?: number;
  };
}

const tokenUsageSchema = new Schema<ITokenUsage>(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    category: {
      type: String,
      enum: [
        "conversation",
        "proactive",
        "routine",
        "watcher",
        "curation",
        "image-selection",
        "image-generation",
        "tts-generation",
        "stt-transcription",
      ],
      required: true,
    },
    modelName: { type: String, required: true },
    provider: { type: String, required: true },
    promptTokens: { type: Number, required: true, default: 0 },
    completionTokens: { type: Number, required: true, default: 0 },
    totalTokens: { type: Number, required: true, default: 0 },
    estimatedCost: { type: Number, required: true, default: 0 },
    metadata: {
      chatId: { type: String },
      sessionId: { type: String },
      routineId: { type: String },
      watcherId: { type: String },
      toolCalls: { type: Number },
      steps: { type: Number },
    },
  },
  { timestamps: false },
);

tokenUsageSchema.index({ timestamp: -1 });
tokenUsageSchema.index({ category: 1, timestamp: -1 });

export const TokenUsage =
  (mongoose.models.TokenUsage as mongoose.Model<ITokenUsage>) ??
  mongoose.model<ITokenUsage>("TokenUsage", tokenUsageSchema);

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export interface UsageSummary {
  category: UsageCategory;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCost: number;
  count: number;
}

export async function getUsageSummary(start: Date, end: Date): Promise<UsageSummary[]> {
  return TokenUsage.aggregate<UsageSummary>([
    { $match: { timestamp: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: "$category",
        totalPromptTokens: { $sum: "$promptTokens" },
        totalCompletionTokens: { $sum: "$completionTokens" },
        totalTokens: { $sum: "$totalTokens" },
        totalCost: { $sum: "$estimatedCost" },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        category: "$_id",
        totalPromptTokens: 1,
        totalCompletionTokens: 1,
        totalTokens: 1,
        totalCost: { $round: ["$totalCost", 6] },
        count: 1,
      },
    },
    { $sort: { totalCost: -1 } },
  ]);
}

export interface DailyUsage {
  date: string;
  totalTokens: number;
  totalCost: number;
  count: number;
}

export async function getDailyUsage(days = 30): Promise<DailyUsage[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return TokenUsage.aggregate<DailyUsage>([
    { $match: { timestamp: { $gte: cutoff } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
        totalTokens: { $sum: "$totalTokens" },
        totalCost: { $sum: "$estimatedCost" },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id",
        totalTokens: 1,
        totalCost: { $round: ["$totalCost", 6] },
        count: 1,
      },
    },
    { $sort: { date: 1 } },
  ]);
}

export async function getTotalCost(start: Date, end: Date): Promise<number> {
  const result = await TokenUsage.aggregate<{ total: number }>([
    { $match: { timestamp: { $gte: start, $lte: end } } },
    { $group: { _id: null, total: { $sum: "$estimatedCost" } } },
  ]);
  return result[0]?.total ?? 0;
}
