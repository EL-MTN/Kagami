import { config, logger } from "@kokoro/shared";
import {
  generateWorkspaceKey,
  getWorkspaceFileByPath,
  getWorkspaceTotals,
  listWorkspaceFiles,
  readWorkspaceBlob,
  removeWorkspaceBlob,
  softDeleteWorkspaceFile,
  upsertWorkspaceFile,
  writeWorkspaceBlob,
  type WorkspaceFileSource,
} from "@kokoro/db";

/**
 * Persistent file workspace — one global file tree shared across every chat,
 * channel, routine, and (Phase 3) sandbox run. This service owns the policy
 * layer: path normalization, quota enforcement, mime inference, and the
 * write-then-swap blob ordering. The @kokoro/db layer underneath owns raw
 * storage (WorkspaceFile rows + the `workspace` GridFS bucket).
 *
 * Expected-failure contract: policy violations (bad path, quota breach,
 * missing file) throw WorkspaceError with a user/model-readable message;
 * anything else propagating is an infrastructure fault.
 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const MB = 1024 * 1024;
const MAX_PATH_CHARS = 512;
const MAX_PATH_DEPTH = 8;

// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Normalize a model- or user-supplied workspace path to its canonical
 * relative form. Traversal-proof by construction: absolute paths, `.`/`..`
 * segments, backslashes, and control characters are all rejected rather than
 * resolved. Unicode filenames pass through untouched (inbound iMessage
 * attachments keep their real names in Phase 2).
 */
export function normalizeWorkspacePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new WorkspaceError("path is empty");
  if (trimmed.length > MAX_PATH_CHARS) {
    throw new WorkspaceError(`path exceeds ${MAX_PATH_CHARS} characters`);
  }
  if (trimmed.startsWith("/")) {
    throw new WorkspaceError("path must be relative (no leading /)");
  }
  if (FORBIDDEN_CHARS.test(trimmed)) {
    throw new WorkspaceError("path contains forbidden characters (control chars or backslash)");
  }
  const segments = trimmed.split("/");
  if (segments.length > MAX_PATH_DEPTH) {
    throw new WorkspaceError(`path exceeds ${MAX_PATH_DEPTH} directory levels`);
  }
  for (const segment of segments) {
    if (segment.length === 0)
      throw new WorkspaceError("path has an empty segment (// or trailing /)");
    if (segment === "." || segment === "..") {
      throw new WorkspaceError("path segments . and .. are not allowed");
    }
    if (segment !== segment.trim()) {
      throw new WorkspaceError("path segments must not start or end with whitespace");
    }
  }
  return segments.join("/");
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  ics: "text/calendar",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessMimeType(path: string, fallback = "application/octet-stream"): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? fallback;
}

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/yaml",
  "application/xml",
  "application/javascript",
  "image/svg+xml",
]);

/**
 * Whether the stored bytes are displayable as text in a tool result. Mime
 * first; for unknown/octet-stream types, a NUL-byte sniff over the first 8 KB
 * (text encodings never contain NUL; every common binary container does
 * within its header).
 */
export function isTextFile(mimeType: string, data: Buffer): boolean {
  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) return true;
  if (mimeType !== "application/octet-stream") return false;
  return !data.subarray(0, 8192).includes(0);
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

export interface WorkspaceWriteInput {
  path: string;
  data: Buffer;
  mimeType?: string;
  source: WorkspaceFileSource;
  sourceChatId?: string | null;
  /** Replace an existing live file at this path. Default false — a write
   * landing on an occupied path fails so the model can't clobber blind. */
  overwrite?: boolean;
}

export interface WorkspaceWriteResult {
  path: string;
  size: number;
  mimeType: string;
  overwritten: boolean;
}

export async function writeWorkspaceFile(
  input: WorkspaceWriteInput,
): Promise<WorkspaceWriteResult> {
  const path = normalizeWorkspacePath(input.path);
  const size = input.data.length;
  const maxFileBytes = config.WORKSPACE_MAX_FILE_MB * MB;
  if (size > maxFileBytes) {
    throw new WorkspaceError(
      `file is ${humanBytes(size)} — exceeds the ${config.WORKSPACE_MAX_FILE_MB} MB per-file cap`,
    );
  }

  const existing = await getWorkspaceFileByPath(path);
  if (existing && !input.overwrite) {
    throw new WorkspaceError(
      `a file already exists at "${path}" (${humanBytes(existing.size)}) — pass overwrite to replace it`,
    );
  }

  const totals = await getWorkspaceTotals();
  const projectedBytes = totals.totalBytes - (existing?.size ?? 0) + size;
  const maxTotalBytes = config.WORKSPACE_MAX_TOTAL_MB * MB;
  if (projectedBytes > maxTotalBytes) {
    throw new WorkspaceError(
      `workspace is full — ${humanBytes(totals.totalBytes)} of ${config.WORKSPACE_MAX_TOTAL_MB} MB used; delete files to make room`,
    );
  }
  if (!existing && totals.count + 1 > config.WORKSPACE_MAX_FILES) {
    throw new WorkspaceError(
      `workspace holds ${totals.count} files — the ${config.WORKSPACE_MAX_FILES}-file cap is reached; delete files to make room`,
    );
  }

  const mimeType = input.mimeType ?? guessMimeType(path);
  const gridfsKey = generateWorkspaceKey();
  await writeWorkspaceBlob(gridfsKey, input.data, mimeType);
  const { previousGridfsKey } = await upsertWorkspaceFile({
    path,
    gridfsKey,
    size,
    mimeType,
    source: input.source,
    sourceChatId: input.sourceChatId ?? null,
  });
  if (previousGridfsKey) {
    // Best-effort: an orphaned blob is invisible (no row points at it) and
    // costs only storage; failing the write over it would be backwards.
    try {
      await removeWorkspaceBlob(previousGridfsKey);
    } catch (error) {
      logger.warn({ error, path, previousGridfsKey }, "Workspace: stale blob removal failed");
    }
  }
  logger.info({ path, size, mimeType, source: input.source }, "Workspace: file written");
  return { path, size, mimeType, overwritten: existing !== null };
}

export interface WorkspaceReadResult {
  path: string;
  data: Buffer;
  mimeType: string;
  size: number;
  updatedAt: Date;
}

export async function readWorkspaceFile(rawPath: string): Promise<WorkspaceReadResult> {
  const path = normalizeWorkspacePath(rawPath);
  const row = await getWorkspaceFileByPath(path);
  if (!row) throw new WorkspaceError(`no file at "${path}"`);
  const blob = await readWorkspaceBlob(row.gridfsKey);
  if (!blob) {
    // Row without bytes = interrupted write or external tampering. Surfaced
    // as an expected error so the model relays it instead of retrying.
    logger.error({ path, gridfsKey: row.gridfsKey }, "Workspace: row has no blob");
    throw new WorkspaceError(`"${path}" is corrupted (no stored bytes) — delete and re-create it`);
  }
  return {
    path,
    data: blob.data,
    mimeType: row.mimeType,
    size: row.size,
    updatedAt: row.updatedAt,
  };
}

export interface WorkspaceListing {
  files: Array<{ path: string; size: number; mimeType: string; updatedAt: Date; source: string }>;
  count: number;
  totalBytes: number;
}

export async function listWorkspace(prefix?: string): Promise<WorkspaceListing> {
  const rows = await listWorkspaceFiles();
  const normalizedPrefix = prefix?.trim() ? normalizeWorkspacePath(prefix) : null;
  const files = rows
    .filter(
      (r) =>
        !normalizedPrefix ||
        r.path === normalizedPrefix ||
        r.path.startsWith(`${normalizedPrefix}/`),
    )
    .map((r) => ({
      path: r.path,
      size: r.size,
      mimeType: r.mimeType,
      updatedAt: r.updatedAt,
      source: r.source,
    }));
  return {
    files,
    count: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
  };
}

/** Move a file to trash (30-day retention before the daily purge). */
export async function deleteWorkspaceFile(rawPath: string): Promise<void> {
  const path = normalizeWorkspacePath(rawPath);
  const deleted = await softDeleteWorkspaceFile(path);
  if (!deleted) throw new WorkspaceError(`no file at "${path}"`);
  logger.info({ path, size: deleted.size }, "Workspace: file moved to trash");
}

const SUMMARY_MAX_PATHS = 8;

/**
 * One-line workspace summary for the system prompt, or null when the
 * workspace is empty (an empty workspace earns zero prompt tokens). Most
 * recently touched files first so what the model just made stays visible.
 */
export async function workspaceSummary(): Promise<string | null> {
  const rows = await listWorkspaceFiles();
  if (rows.length === 0) return null;
  const totalBytes = rows.reduce((sum, r) => sum + r.size, 0);
  const recent = [...rows]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, SUMMARY_MAX_PATHS)
    .map((r) => r.path);
  const more = rows.length > recent.length ? `, +${rows.length - recent.length} more` : "";
  return `## Workspace\nPersistent files (${rows.length}, ${humanBytes(totalBytes)}): ${recent.join(", ")}${more}. Use listFiles/readFile/writeFile/deleteFile.`;
}
