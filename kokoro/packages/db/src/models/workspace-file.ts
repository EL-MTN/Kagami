import mongoose, { Schema, type Document } from "mongoose";
import { removeWorkspaceBlobs } from "../gridfs";

export type WorkspaceFileSource = "chat-upload" | "agent" | "sandbox";

export interface IWorkspaceFile extends Document {
  id: string;
  /** Normalized relative path, unique among live files ("reports/june.csv"). */
  path: string;
  /** GridFS key in the `workspace` bucket holding this file's current bytes. */
  gridfsKey: string;
  size: number;
  mimeType: string;
  source: WorkspaceFileSource;
  /**
   * Which chat the bytes arrived through (provenance only — the workspace is
   * global and access is never scoped by it). Null for files authored outside
   * a chat context (sandbox sync-back, dashboard upload).
   */
  sourceChatId: string | null;
  /** Soft-delete marker. Non-null = in trash, awaiting the 30-day purge. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const workspaceFileSchema = new Schema<IWorkspaceFile>(
  {
    path: { type: String, required: true },
    gridfsKey: { type: String, required: true },
    size: { type: Number, required: true },
    mimeType: { type: String, required: true },
    source: { type: String, enum: ["chat-upload", "agent", "sandbox"], required: true },
    sourceChatId: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Unique among LIVE files only — trash may hold several generations of the
// same path, and a re-created file must not collide with its trashed
// predecessor.
workspaceFileSchema.index(
  { path: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
workspaceFileSchema.index({ deletedAt: 1 });

export const WorkspaceFile =
  (mongoose.models.WorkspaceFile as mongoose.Model<IWorkspaceFile>) ??
  mongoose.model<IWorkspaceFile>("WorkspaceFile", workspaceFileSchema);

export interface WorkspaceFileInput {
  path: string;
  gridfsKey: string;
  size: number;
  mimeType: string;
  source: WorkspaceFileSource;
  sourceChatId?: string | null;
}

/**
 * Create or overwrite the live file at `input.path`, returning the previous
 * generation's GridFS key (null on a fresh create) so the caller can remove
 * the orphaned blob AFTER the row points at the new one — ordering that keeps
 * a crash window from ever leaving a live path with no bytes behind it.
 */
export async function upsertWorkspaceFile(
  input: WorkspaceFileInput,
): Promise<{ previousGridfsKey: string | null }> {
  const previous = await WorkspaceFile.findOneAndUpdate(
    { path: input.path, deletedAt: null },
    {
      $set: {
        gridfsKey: input.gridfsKey,
        size: input.size,
        mimeType: input.mimeType,
        source: input.source,
        sourceChatId: input.sourceChatId ?? null,
      },
    },
    { upsert: true, returnDocument: "before" },
  );
  return { previousGridfsKey: previous?.gridfsKey ?? null };
}

export async function getWorkspaceFileByPath(path: string): Promise<IWorkspaceFile | null> {
  return WorkspaceFile.findOne({ path, deletedAt: null });
}

export async function listWorkspaceFiles(): Promise<IWorkspaceFile[]> {
  return WorkspaceFile.find({ deletedAt: null }).sort({ path: 1 });
}

/** Live-file totals for quota checks and the system-prompt summary. */
export async function getWorkspaceTotals(): Promise<{ count: number; totalBytes: number }> {
  const [row] = await WorkspaceFile.aggregate<{ count: number; totalBytes: number }>([
    { $match: { deletedAt: null } },
    { $group: { _id: null, count: { $sum: 1 }, totalBytes: { $sum: "$size" } } },
    { $project: { _id: 0 } },
  ]);
  return row ?? { count: 0, totalBytes: 0 };
}

/** Move the live file at `path` to trash. Returns the doc, or null if absent. */
export async function softDeleteWorkspaceFile(path: string): Promise<IWorkspaceFile | null> {
  return WorkspaceFile.findOneAndUpdate(
    { path, deletedAt: null },
    { deletedAt: new Date() },
    { returnDocument: "after" },
  );
}

/**
 * Permanently remove trashed files older than `olderThanDays` — blobs first,
 * rows second, so an interrupted purge leaves re-purgeable rows rather than
 * unreachable blobs. Returns the number of files purged.
 */
export async function purgeDeletedWorkspaceFiles(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000);
  const expired = await WorkspaceFile.find({ deletedAt: { $ne: null, $lte: cutoff } });
  if (expired.length === 0) return 0;
  await removeWorkspaceBlobs(expired.map((f) => f.gridfsKey));
  await WorkspaceFile.deleteMany({ _id: { $in: expired.map((f) => f._id) } });
  return expired.length;
}
