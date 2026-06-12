import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { config, logger } from "@kokoro/shared";
import { listWorkspaceFiles, readWorkspaceBlob } from "@kokoro/db";
import {
  WorkspaceError,
  deleteWorkspaceFile,
  humanBytes,
  normalizeWorkspacePath,
  writeWorkspaceFile,
} from "./workspace";

/**
 * Workspace ↔ sandbox bridge: materialize the canonical (GridFS-backed)
 * workspace into an ephemeral host directory for a `--volume` mount, then
 * diff the directory after the run and sync changes back through the normal
 * workspace write/quota path.
 *
 * The sandbox NEVER touches the canonical store — a runaway script can only
 * corrupt its ephemeral copy, quotas are enforced at the sync checkpoint,
 * and a torn run (timeout/OOM) is simply not synced. The ephemeral copy is
 * chmod 0777/0666: on Docker Desktop (macOS) VirtioFS uid-maps and doesn't
 * need it, but on a Linux host the container's nobody user (65534) really is
 * a foreign uid, so the loose mode is what makes the mount writable there.
 */

export interface WorkspaceMaterialization {
  /** Host directory to bind-mount at /workspace. */
  dir: string;
  /** path → sha256 of every file materialized, for the post-run diff. */
  manifest: Map<string, string>;
}

export interface WorkspaceSyncDelta {
  /** Files created by the run (path + human size). */
  added: Array<{ path: string; size: number }>;
  /** Files whose content changed. */
  modified: Array<{ path: string; size: number }>;
  /** Files the run deleted (moved to workspace trash). */
  deleted: string[];
  /** Files that could not be synced, with the policy reason (quota, bad path). */
  skipped: Array<{ path: string; reason: string }>;
}

// One workspace-mounted run at a time. The sandbox itself allows two
// concurrent runs, but two concurrent *workspace* runs would race the
// materialize→sync window (last sync wins per file, silently) — serializing
// is cheap and removes the class of bug.
let workspaceRunChain: Promise<unknown> = Promise.resolve();

export function withWorkspaceSandboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = workspaceRunChain.then(fn, fn);
  workspaceRunChain = next.catch(() => {});
  return next;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Copy every live workspace file into a fresh temp directory. Rows whose
 * blob is missing (torn write, tampering) are skipped with a warning rather
 * than failing the whole run — the sync-back diff treats "absent at
 * materialize, absent after" as no change, so the corrupt row is untouched.
 */
export async function materializeWorkspace(): Promise<WorkspaceMaterialization> {
  const dir = await mkdtemp(nodePath.join(os.tmpdir(), "kokoro-ws-"));
  await chmod(dir, 0o777);
  const manifest = new Map<string, string>();
  // Directories already created and chmod'd this run. Files in the same
  // subtree share ancestors, so without this every file would re-chmod the
  // same parents — O(files × depth) syscalls instead of O(distinct dirs).
  const chmodded = new Set<string>([dir]);

  const rows = await listWorkspaceFiles();
  for (const row of rows) {
    const blob = await readWorkspaceBlob(row.gridfsKey);
    if (!blob) {
      logger.warn({ path: row.path }, "Workspace materialize: row has no blob; skipped");
      continue;
    }
    // Workspace paths are pre-normalized (no .., no absolute, no backslash),
    // so joining under the temp dir cannot escape it.
    const hostPath = nodePath.join(dir, row.path);
    const parent = nodePath.dirname(hostPath);
    if (parent !== dir && !chmodded.has(parent)) {
      await mkdir(parent, { recursive: true, mode: 0o777 });
      // mkdir's mode is masked by the process umask — re-chmod so foreign-uid
      // writers (Linux hosts) can create files in nested directories too. Walk
      // up to the first already-handled ancestor, marking each so a sibling
      // file doesn't repeat the walk.
      for (let p = parent; !chmodded.has(p); p = nodePath.dirname(p)) {
        await chmod(p, 0o777);
        chmodded.add(p);
      }
    }
    await writeFile(hostPath, blob.data, { mode: 0o666 });
    await chmod(hostPath, 0o666);
    // Key by the NFC form so the post-run readback (which normalizeWorkspacePath
    // also NFC-folds) matches even when the mount returns NFD.
    manifest.set(row.path.normalize("NFC"), sha256(blob.data));
  }

  logger.debug({ dir, files: manifest.size }, "Workspace materialized for sandbox run");
  return { dir, manifest };
}

/**
 * Diff the post-run directory against the materialization manifest and push
 * the changes through the canonical workspace write path (quotas included).
 * Non-regular files (symlinks, sockets, …) and files whose names don't
 * survive path normalization are skipped and reported — never synced.
 */
export async function syncBackWorkspace(
  materialization: WorkspaceMaterialization,
): Promise<WorkspaceSyncDelta> {
  const { dir, manifest } = materialization;
  const delta: WorkspaceSyncDelta = { added: [], modified: [], deleted: [], skipped: [] };
  const seen = new Set<string>();

  // Safety valve: the deletion pass below soft-deletes every manifest path
  // the run didn't leave behind. The fault signal for "the run dir itself is
  // suspect" (vanished tmpdir, disk fault) is readdir THROWING — an empty
  // but traversable directory is a legitimate, user-approved delete-all
  // (e.g. `rm -rf /workspace/*`) and must sync as deletions, not be
  // discarded.
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    logger.error(
      { error, dir, manifestSize: manifest.size },
      "Workspace sync-back: run dir unreadable; skipping to avoid mass-delete",
    );
    delta.skipped.push({ path: "(all)", reason: "run directory unreadable; sync skipped" });
    return delta;
  }

  // Pass 1 — enumerate: classify every surviving file and size-gate it
  // WITHOUT reading it. An approved run can write (or sparsely truncate) a
  // multi-GB file; reading it just to have writeWorkspaceFile reject it
  // later would buffer the whole thing in the bot process. `seen` is marked
  // before the gate, so a skipped-oversized file never soft-deletes its
  // original. Stat failures (file vanished mid-sync) also skip the file,
  // never the delta.
  const maxFileBytes = config.WORKSPACE_MAX_FILE_MB * 1024 * 1024;
  const pendingWrites: Array<{ path: string; hostPath: string; previous: string | undefined }> = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const hostPath = nodePath.join(entry.parentPath, entry.name);
    const relPath = nodePath.relative(dir, hostPath).split(nodePath.sep).join("/");
    if (!entry.isFile()) {
      delta.skipped.push({ path: relPath, reason: "not a regular file" });
      continue;
    }

    let path: string;
    try {
      path = normalizeWorkspacePath(relPath);
    } catch (error) {
      const reason = error instanceof WorkspaceError ? error.message : "invalid path";
      delta.skipped.push({ path: relPath, reason });
      continue;
    }
    seen.add(path);

    let size: number;
    try {
      size = (await stat(hostPath)).size;
    } catch {
      delta.skipped.push({ path, reason: "unreadable after the run" });
      continue;
    }
    if (size > maxFileBytes) {
      delta.skipped.push({
        path,
        reason: `file is ${humanBytes(size)} — exceeds the ${config.WORKSPACE_MAX_FILE_MB} MB per-file cap`,
      });
      continue;
    }

    pendingWrites.push({ path, hostPath, previous: manifest.get(path) });
  }

  // Pass 2 — deletions FIRST: anything materialized but absent after the
  // run was deleted by the code. Soft delete — the workspace trash keeps
  // the previous generation 30 days. Running deletions before the writes
  // matters for quota: a run that deletes a large input to make room for
  // its output must have that room actually freed before the output is
  // checked against WORKSPACE_MAX_TOTAL_MB / WORKSPACE_MAX_FILES.
  for (const path of manifest.keys()) {
    if (seen.has(path)) continue;
    try {
      await deleteWorkspaceFile(path);
      delta.deleted.push(path);
    } catch (error) {
      logger.warn({ error, path }, "Workspace sync-back: delete failed");
      delta.skipped.push({ path, reason: "delete failed" });
    }
  }

  // Pass 3 — writes, through the canonical quota-enforcing path.
  for (const { path, hostPath, previous } of pendingWrites) {
    let data: Buffer;
    try {
      data = await readFile(hostPath);
    } catch {
      delta.skipped.push({ path, reason: "unreadable after the run" });
      continue;
    }
    if (previous && previous === sha256(data)) continue; // unchanged

    try {
      const result = await writeWorkspaceFile({
        path,
        data,
        source: "sandbox",
        sourceChatId: null,
        overwrite: true,
      });
      if (previous) {
        delta.modified.push({ path: result.path, size: result.size });
      } else {
        delta.added.push({ path: result.path, size: result.size });
      }
    } catch (error) {
      const reason = error instanceof WorkspaceError ? error.message : "write failed";
      logger.warn({ error, path }, "Workspace sync-back: file skipped");
      delta.skipped.push({ path, reason });
    }
  }

  logger.info(
    {
      added: delta.added.length,
      modified: delta.modified.length,
      deleted: delta.deleted.length,
      skipped: delta.skipped.length,
    },
    "Workspace sync-back complete",
  );
  return delta;
}

/** Best-effort removal of the ephemeral copy. */
export async function cleanupWorkspaceDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ error, dir }, "Workspace sandbox dir cleanup failed");
  }
}

// Cap per delta category in the human summary. The summary lands in the
// edited approval bubble AND (via appendConfirmationResolution) in the next
// LLM context — a run touching hundreds of long paths must not produce a
// platform-rejected message or a context bomb.
const DELTA_SUMMARY_CAP = 5;

function capped(items: string[]): string {
  const shown = items.slice(0, DELTA_SUMMARY_CAP);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ");
}

/**
 * One-line human summary of a sync delta for the approval bubble and the
 * conversation resolution event. Null when the run changed nothing. Each
 * category shows at most DELTA_SUMMARY_CAP paths plus a remainder count.
 */
export function formatWorkspaceDelta(delta: WorkspaceSyncDelta): string | null {
  const parts: string[] = [];
  if (delta.added.length > 0) {
    parts.push(`wrote ${capped(delta.added.map((f) => `${f.path} (${humanBytes(f.size)})`))}`);
  }
  if (delta.modified.length > 0) {
    parts.push(`modified ${capped(delta.modified.map((f) => f.path))}`);
  }
  if (delta.deleted.length > 0) {
    parts.push(`deleted ${capped(delta.deleted)}`);
  }
  if (delta.skipped.length > 0) {
    parts.push(`skipped ${capped(delta.skipped.map((f) => `${f.path} (${f.reason})`))}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
