import { tool } from "ai";
import { z } from "zod";
import { logger } from "@kokoro/shared";
import {
  WorkspaceError,
  deleteWorkspaceFile,
  humanBytes,
  isTextFile,
  listWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../../services/workspace";

/**
 * Workspace file tools — the model-facing surface of the persistent
 * workspace. One global file tree shared across chats, channels, and
 * routines; nothing here is chat-scoped (the writer's chatId is recorded as
 * provenance only).
 *
 * Failure contract mirrors the memory tools: WorkspaceError carries a
 * model-readable policy reason (bad path, quota, missing file) and is
 * relayed verbatim; anything else is an infrastructure fault reported as
 * `degraded` so the model keeps responding instead of retrying blind.
 */

// Same chunk size as the browse tool's `visit` — one tool result stays a
// bounded slice of context regardless of file size.
const READ_CHUNK_CHARS = 4000;

// writeFile is for text the model authors directly in a tool call. Larger
// artifacts enter the workspace as inbound attachments or (Phase 3) sandbox
// output — pushing megabytes through tool-call args is the wrong transport.
const WRITE_MAX_CHARS = 48 * 1024;

function failureFrom(
  err: unknown,
  op: string,
): { success: false; reason: string; degraded?: boolean } {
  if (err instanceof WorkspaceError) {
    return { success: false, reason: err.message };
  }
  const reason = err instanceof Error ? err.message : `${op} failed`;
  return { success: false, reason, degraded: true };
}

export function createListFilesTool() {
  return tool({
    description:
      "List files in the persistent workspace — one global file tree shared across all chats and routines; files survive across sessions. Returns path, size, type, and last-modified for each file.",
    inputSchema: z.object({
      prefix: z
        .string()
        .optional()
        .describe('Optional directory filter, e.g. "inbox" or "reports/2026".'),
    }),
    execute: async ({ prefix }) => {
      try {
        logger.debug({ prefix }, "Tool: listFiles");
        const listing = await listWorkspace(prefix);
        return {
          success: true,
          count: listing.count,
          totalSize: humanBytes(listing.totalBytes),
          files: listing.files.map((f) => ({
            path: f.path,
            size: humanBytes(f.size),
            mimeType: f.mimeType,
            modified: f.updatedAt.toISOString(),
          })),
        };
      } catch (err) {
        logger.warn({ error: err, prefix }, "Tool: listFiles failed");
        return failureFrom(err, "listing files");
      }
    },
  });
}

export function createReadFileTool() {
  return tool({
    description: `Read a file from the persistent workspace. Text files return up to ${READ_CHUNK_CHARS} characters per call — pass offset to continue reading a longer file. Binary files return metadata only.`,
    inputSchema: z.object({
      path: z.string().min(1).describe('Workspace path, e.g. "inbox/notes.md".'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to start from (for continuing a long text file)."),
    }),
    execute: async ({ path, offset }) => {
      try {
        logger.debug({ path, offset }, "Tool: readFile");
        const file = await readWorkspaceFile(path);
        if (!isTextFile(file.mimeType, file.data)) {
          return {
            success: true,
            path: file.path,
            mimeType: file.mimeType,
            size: humanBytes(file.size),
            binary: true,
            note: "binary file — content not displayable as text",
          };
        }
        const text = file.data.toString("utf-8");
        const start = offset ?? 0;
        const content = text.slice(start, start + READ_CHUNK_CHARS);
        const hasMore = start + READ_CHUNK_CHARS < text.length;
        return {
          success: true,
          path: file.path,
          mimeType: file.mimeType,
          totalChars: text.length,
          offset: start,
          content,
          hasMore,
          ...(hasMore ? { nextOffset: start + READ_CHUNK_CHARS } : {}),
        };
      } catch (err) {
        logger.warn({ error: err, path }, "Tool: readFile failed");
        return failureFrom(err, "reading the file");
      }
    },
  });
}

export function createWriteFileTool(sourceChatId: string) {
  return tool({
    description: `Write a text file to the persistent workspace (global — visible from every chat and routine, survives across sessions). Up to ${WRITE_MAX_CHARS} characters of UTF-8 text per write; writing to an existing path requires overwrite. Use it for durable artifacts: drafts, notes, datasets, anything worth keeping beyond this conversation.`,
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe('Relative path, directories allowed, e.g. "drafts/trip-plan.md".'),
      content: z.string().max(WRITE_MAX_CHARS).describe("Full file content (UTF-8 text)."),
      overwrite: z
        .boolean()
        .optional()
        .describe("Must be true to replace a file that already exists at this path."),
    }),
    execute: async ({ path, content, overwrite }) => {
      try {
        logger.debug({ path, contentChars: content.length, overwrite }, "Tool: writeFile");
        const result = await writeWorkspaceFile({
          path,
          data: Buffer.from(content, "utf-8"),
          source: "agent",
          sourceChatId,
          overwrite,
        });
        return {
          success: true,
          path: result.path,
          size: humanBytes(result.size),
          mimeType: result.mimeType,
          overwritten: result.overwritten,
        };
      } catch (err) {
        logger.error({ error: err, path }, "Tool: writeFile failed");
        return failureFrom(err, "writing the file");
      }
    },
  });
}

export function createDeleteFileTool() {
  return tool({
    description:
      "Delete a file from the persistent workspace. Soft delete: the file moves to trash and is recoverable for 30 days before being purged.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Workspace path of the file to delete."),
    }),
    execute: async ({ path }) => {
      try {
        logger.debug({ path }, "Tool: deleteFile");
        await deleteWorkspaceFile(path);
        return { success: true, path, note: "moved to trash (recoverable for 30 days)" };
      } catch (err) {
        logger.error({ error: err, path }, "Tool: deleteFile failed");
        return failureFrom(err, "deleting the file");
      }
    },
  });
}
