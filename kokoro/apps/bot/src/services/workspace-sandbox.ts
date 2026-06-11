import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { logger } from "@kokoro/shared";
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
    if (parent !== dir) {
      await mkdir(parent, { recursive: true, mode: 0o777 });
      // mkdir's mode is masked by the process umask — re-chmod so foreign-uid
      // writers (Linux hosts) can create files in nested directories too.
      for (let p = parent; p.length > dir.length && p.startsWith(dir); p = nodePath.dirname(p)) {
        await chmod(p, 0o777);
      }
    }
    await writeFile(hostPath, blob.data, { mode: 0o666 });
    await chmod(hostPath, 0o666);
    manifest.set(row.path, sha256(blob.data));
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

  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
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

    const data = await readFile(hostPath);
    const previous = manifest.get(path);
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

  // Anything materialized but absent after the run was deleted by the code.
  // Soft delete — the workspace trash keeps the previous generation 30 days.
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

/**
 * One-line human summary of a sync delta for the approval bubble and the
 * conversation resolution event. Null when the run changed nothing.
 */
export function formatWorkspaceDelta(delta: WorkspaceSyncDelta): string | null {
  const parts: string[] = [];
  if (delta.added.length > 0) {
    parts.push(`wrote ${delta.added.map((f) => `${f.path} (${humanBytes(f.size)})`).join(", ")}`);
  }
  if (delta.modified.length > 0) {
    parts.push(`modified ${delta.modified.map((f) => f.path).join(", ")}`);
  }
  if (delta.deleted.length > 0) {
    parts.push(`deleted ${delta.deleted.join(", ")}`);
  }
  if (delta.skipped.length > 0) {
    parts.push(`skipped ${delta.skipped.map((f) => `${f.path} (${f.reason})`).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
