import { config, logger } from "@kokoro/shared";
import {
  generateWorkspaceKey,
  getWorkspaceFileByPath,
  getWorkspaceTotals,
  isDuplicateKeyError,
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

/**
 * A write lost the race for an occupied path: the file existed (or another
 * write created it concurrently) and `overwrite` wasn't set. A subclass so
 * callers that can recover — `saveInboundDocument` deduping to the next
 * numbered name — can catch *only* this, not a quota breach or a bad path.
 */
export class WorkspaceExistsError extends WorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceExistsError";
  }
}

const MB = 1024 * 1024;
const MAX_PATH_CHARS = 512;
const MAX_PATH_DEPTH = 8;

/**
 * Serializes the read-check-then-commit body of every workspace write. Writes
 * can originate concurrently — un-serialized Telegram/iMessage webhook
 * handlers, conversational tool turns, and sandbox sync-back — and the
 * quota/occupancy checks are check-then-act: without this lock two writers
 * read the same pre-write totals, both pass the cap, and both commit
 * (breaching the quota), or both miss the existence check for one new path and
 * the second hits the partial-unique index's E11000. The whole critical
 * section (existence + quota reads through the blob write and row upsert) runs
 * under the lock so those reads stay authoritative through the commit. Single
 * writer at a time is fine at this workload; the blob write it covers is the
 * same one the sandbox sync-back already issues sequentially.
 */
let workspaceWriteChain: Promise<unknown> = Promise.resolve();

function withWorkspaceWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = workspaceWriteChain.then(fn, fn);
  workspaceWriteChain = next.catch(() => {});
  return next;
}

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
  // Canonicalize to NFC so the same name in different Unicode normal forms maps
  // to one file. This is the single chokepoint every workspace path passes
  // through, so storage keys, the sandbox materialize manifest, and post-run
  // readback all agree — without it, a filesystem that returns NFD (Docker
  // Desktop's VirtioFS mount) would make an unchanged "café.txt" miss its
  // manifest key on sync-back and get soft-deleted.
  return segments.join("/").normalize("NFC");
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
  // Per-file cap is independent of workspace state, so it's checked outside
  // the lock — no point serializing a write that can't fit on its own.
  if (size > maxFileBytes) {
    throw new WorkspaceError(
      `file is ${humanBytes(size)} — exceeds the ${config.WORKSPACE_MAX_FILE_MB} MB per-file cap`,
    );
  }

  // Existence + quota reads through the commit run under one lock so a
  // concurrent write can't invalidate them between check and act.
  return withWorkspaceWriteLock(async () => {
    const existing = await getWorkspaceFileByPath(path);
    if (existing && !input.overwrite) {
      throw new WorkspaceExistsError(
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
    let previousGridfsKey: string | null;
    try {
      ({ previousGridfsKey } = await upsertWorkspaceFile({
        path,
        gridfsKey,
        size,
        mimeType,
        source: input.source,
        sourceChatId: input.sourceChatId ?? null,
      }));
    } catch (error) {
      // The lock makes a same-path race impossible from within this process,
      // but the partial-unique index is the real arbiter (another process, or
      // a soft-deleted row reactivating). Translate its E11000 into the
      // typed exists-error so it reads as policy, not an infra "degraded"
      // fault — and so saveInboundDocument's dedupe can recover. Drop the
      // now-orphaned blob we just wrote.
      if (isDuplicateKeyError(error)) {
        await removeWorkspaceBlob(gridfsKey).catch(() => {});
        throw new WorkspaceExistsError(`a file already exists at "${path}"`);
      }
      throw error;
    }
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
  });
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

// Reverse mime→extension lookup for inbound attachments with no filename.
function extensionForMime(mimeType: string | undefined): string {
  if (!mimeType) return "";
  for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
    if (mime === mimeType) return `.${ext}`;
  }
  return "";
}

/**
 * Reduce a platform-supplied attachment filename to a single safe path
 * segment: path separators and control characters become hyphens, dot-only
 * names fall back to "file", and the stem is capped at 120 chars with the
 * extension preserved.
 */
export function sanitizeFileName(raw: string | undefined, mimeType?: string): string {
  const cleaned = (raw ?? "")
    .replace(/[/\\]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "-")
    .trim()
    .replace(/^\.+$/, "");
  if (!cleaned) return `file${extensionForMime(mimeType)}`;
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

export interface SaveInboundDocumentInput {
  fileName?: string;
  data: Buffer;
  mimeType?: string;
  sourceChatId: string;
}

/**
 * Save an inbound chat attachment under inbox/, never overwriting: an
 * occupied name gets a numbered sibling (lease.pdf → lease-2.pdf → …), with
 * a random-suffix fallback if a hundred generations of the same name
 * somehow exist. Quota violations propagate as WorkspaceError for the
 * message handler to relay.
 */
export async function saveInboundDocument(
  input: SaveInboundDocumentInput,
): Promise<WorkspaceWriteResult> {
  const name = sanitizeFileName(input.fileName, input.mimeType);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const mimeType = input.mimeType ?? guessMimeType(name);

  // Try to claim a name, advancing the suffix on collision. Each attempt is an
  // atomic write (overwrite:false) — letting writeWorkspaceFile's lock + unique
  // index be the arbiter rather than a separate "is this name free?" query that
  // a concurrent upload could invalidate before we write (the check-then-write
  // race). WorkspaceExistsError is the only recoverable failure; a quota breach
  // or bad path propagates immediately.
  for (let i = 1; ; i++) {
    const candidate =
      i === 1
        ? `inbox/${name}`
        : i > 100
          ? `inbox/${stem}-${generateWorkspaceKey().slice(0, 8)}${ext}`
          : `inbox/${stem}-${i}${ext}`;
    try {
      return await writeWorkspaceFile({
        path: candidate,
        data: input.data,
        mimeType,
        source: "chat-upload",
        sourceChatId: input.sourceChatId,
      });
    } catch (error) {
      // The random-suffix fallback (i > 100) collides with negligible
      // probability; if even that loses the race, give up rather than spin.
      if (error instanceof WorkspaceExistsError && i <= 100) continue;
      throw error;
    }
  }
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
