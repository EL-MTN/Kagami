import { Types } from "mongoose";
import type { Config } from "../config.js";
import { SyncState } from "../db/models/SyncState.js";
import { recordInteraction, type RecordInteractionInput } from "../db/recordInteraction.js";
import { logger } from "../lib/logger.js";
import { OAuthError } from "../lib/kao-client.js";
import type { GmailClient } from "./gmail-client.js";
import { GmailHttpError } from "./gmail-client.js";
import { GoogleRequestTimeoutError } from "./google-timeout.js";
import {
  parseGmailMessage,
  senderDomain,
  type ParsedAddress,
  type ParsedMessage,
} from "./parse-message.js";
import { upsertPerson } from "./upsert-person.js";

export type SyncResult = {
  status: "ok" | "paused" | "no_grant" | "error";
  fetched: number;
  inserted: number;
  skippedExisting: number;
  skippedNewsletter: number;
  errors: number;
  historyIdAfter: string | null;
  message?: string;
};

const MESSAGE_LIST_PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 500;

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function isBlocklisted(addr: ParsedAddress | null, blocklist: string[]): boolean {
  const domain = senderDomain(addr);
  if (!domain) return false;
  return blocklist.includes(domain);
}

async function loadOrInitState() {
  const existing = await SyncState.findOne({ provider: "gmail" });
  if (existing) return existing;
  return await SyncState.create({
    provider: "gmail",
    historyId: null,
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    pausedAt: null,
    source: "gmail-sync",
  });
}

async function pauseWith(message: string): Promise<void> {
  logger.error({ provider: "gmail", reason: message }, "gmail ingest paused — re-grant required");
  await SyncState.updateOne(
    { provider: "gmail" },
    {
      $set: {
        pausedAt: new Date(),
        lastError: message,
        lastRunAt: new Date(),
      },
      $inc: { errorCount: 1 },
    },
  );
}

async function recordSuccessfulRun(historyIdAfter: string | null): Promise<void> {
  const update: Record<string, unknown> = {
    lastRunAt: new Date(),
    lastError: null,
  };
  if (historyIdAfter !== null) update.historyId = historyIdAfter;
  await SyncState.updateOne({ provider: "gmail" }, { $set: update });
}

async function recordFailedRun(message: string): Promise<void> {
  await SyncState.updateOne(
    { provider: "gmail" },
    {
      $set: { lastError: message, lastRunAt: new Date() },
      $inc: { errorCount: 1 },
    },
  );
}

// "no_grant" is neither success nor failure — the operator simply hasn't
// (re-)consented yet. Update lastRunAt and clear lastError so a stale
// "invalid_grant" message from before re-consent doesn't linger on the
// dashboard alongside a fresh status:'no_grant' result. errorCount stays
// put (this tick didn't fail).
//
// The Mongo write is wrapped in try/catch so a transient DB blip doesn't
// turn a no_grant result into a 500 from POST /sync/gmail/run — the
// status:'no_grant' return shape is part of the route contract.
async function recordIdleRun(): Promise<void> {
  try {
    await SyncState.updateOne(
      { provider: "gmail" },
      { $set: { lastError: null, lastRunAt: new Date() } },
    );
  } catch (err) {
    logger.warn({ error: err }, "gmail: failed to record idle run");
  }
}

async function processMessageIds(
  ids: string[],
  client: GmailClient,
  config: Config,
  result: SyncResult,
): Promise<void> {
  const blocklist = config.NEWSLETTER_DOMAIN_BLOCKLIST;

  for (const id of ids) {
    let raw;
    try {
      raw = await client.getMessage(id);
      result.fetched++;
    } catch (err) {
      // Paths that escape the per-message loop (don't `continue`) should
      // NOT increment `result.errors` — the outer pause/timeout handling
      // owns the bookkeeping. Without this ordering, an OAuthError from
      // the self-heal retry reported `errors:0` (rethrown before the
      // increment) while a fresh 401 → OAuthError reported `errors:1`
      // (incremented before the throw), even though both have the same
      // root cause.
      if (err instanceof GoogleRequestTimeoutError) throw err;
      if (err instanceof OAuthError) throw err;
      if (err instanceof GmailHttpError && err.status === 401) {
        // Log with the message id BEFORE throwing so the operator can
        // pinpoint which message triggered the pause in Kansoku.
        logger.warn({ error: err, id }, "gmail: 401 mid-batch — token rejected");
        throw new OAuthError("invalid_grant", "gmail returned 401 mid-batch");
      }
      if (err instanceof GmailHttpError && err.status === 403) {
        // Google 403 that survived the client's self-heal retry — Google
        // has a real complaint (quota, dailyLimitExceeded, scope
        // misalignment after a force-refresh). Abort the batch so the
        // outer catch lands in recordFailedRun and historyId stays put —
        // otherwise recordSuccessfulRun would advance the cursor past
        // the unprocessed messages and they'd be silently dropped.
        logger.warn({ error: err, id }, "gmail: 403 mid-batch — aborting run");
        throw err;
      }
      // Only true per-message failures (parse error, transient network,
      // non-401/403 HTTP error) reach this point and get counted + skipped.
      result.errors++;
      logger.warn({ error: err, id }, "gmail: failed to fetch message");
      continue;
    }

    let parsed: ParsedMessage;
    try {
      parsed = parseGmailMessage(raw);
    } catch (err) {
      result.errors++;
      logger.warn({ error: err, id }, "gmail: failed to parse message");
      continue;
    }

    if (parsed.hasListUnsubscribe || isBlocklisted(parsed.from, blocklist)) {
      result.skippedNewsletter++;
      continue;
    }

    // Upsert participants. Build unique by email so we don't double-link.
    const personByEmail = new Map<string, Types.ObjectId>();
    const participants: RecordInteractionInput["participants"] = [];

    const link = async (addr: ParsedAddress | null, role: "from" | "to" | "cc") => {
      if (!addr) return;
      let pid = personByEmail.get(addr.email);
      if (!pid) {
        try {
          const r = await upsertPerson({
            email: addr.email,
            displayName: addr.name ?? "",
            occurredAt: parsed.occurredAt,
            source: "gmail-sync",
          });
          pid = r.personId;
          personByEmail.set(addr.email, pid);
        } catch (err) {
          result.errors++;
          logger.warn({ error: err, email: addr.email }, "gmail: upsertPerson failed");
          return;
        }
      }
      participants.push({ personId: pid, role });
    };

    // Skip-self on group emails: drop USER_EMAILS recipients from to/cc when
    // there are >= 2 other recipients. The from role is preserved either way
    // so outbound detection (sender ∈ USER_EMAILS) still works downstream.
    const userSet = new Set(config.USER_EMAILS);
    const toCc: Array<{ addr: ParsedAddress; role: "to" | "cc" }> = [
      ...parsed.to.map((a) => ({ addr: a, role: "to" as const })),
      ...parsed.cc.map((a) => ({ addr: a, role: "cc" as const })),
    ];
    const recipients =
      toCc.filter((p) => !userSet.has(p.addr.email)).length >= 2
        ? toCc.filter((p) => !userSet.has(p.addr.email))
        : toCc;

    await link(parsed.from, "from");
    for (const ar of recipients) await link(ar.addr, ar.role);

    if (participants.length === 0) {
      result.errors++;
      logger.warn({ id }, "gmail: message had no resolvable participants");
      continue;
    }

    try {
      const created = await recordInteraction(
        {
          occurredAt: parsed.occurredAt,
          channel: "email",
          title: parsed.subject,
          body: parsed.bodyText,
          participants,
          ...(parsed.attachments.length > 0
            ? {
                attachments: parsed.attachments.map((a) => ({
                  name: a.name,
                  ...(a.mimeType ? { mimeType: a.mimeType } : {}),
                  ...(a.size != null ? { size: a.size } : {}),
                  ...(a.ref ? { ref: a.ref } : {}),
                })),
              }
            : {}),
          sourceRef: { provider: "gmail", id: parsed.id },
          source: "gmail-sync",
        },
        { skipIfDuplicate: true },
      );
      if (created) {
        result.inserted++;
      } else {
        result.skippedExisting++;
      }
    } catch (err) {
      result.errors++;
      logger.warn({ error: err, id }, "gmail: recordInteraction failed");
    }
  }
}

async function bootstrap(
  client: GmailClient,
  config: Config,
  result: SyncResult,
): Promise<string | null> {
  const profile = await client.getProfile();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - config.KIZUNA_GMAIL_BACKFILL_DAYS);
  const q = `after:${ymd(since)}`;
  logger.info({ q, historyId: profile.historyId }, "gmail bootstrap");

  let pageToken: string | undefined;
  const all: string[] = [];
  while (true) {
    const page = await client.listMessages({
      q,
      maxResults: MESSAGE_LIST_PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    if (page.messages) for (const m of page.messages) all.push(m.id);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  await processMessageIds(all, client, config, result);
  return profile.historyId ?? null;
}

async function incremental(
  startHistoryId: string,
  client: GmailClient,
  config: Config,
  result: SyncResult,
): Promise<string | null> {
  let pageToken: string | undefined;
  const newIds = new Set<string>();
  let latestHistoryId: string | null = null;

  while (true) {
    const page = await client.listHistory({
      startHistoryId,
      maxResults: HISTORY_PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    if (page.historyId) latestHistoryId = page.historyId;
    if (page.history) {
      for (const rec of page.history) {
        if (rec.messagesAdded) {
          for (const a of rec.messagesAdded) newIds.add(a.message.id);
        }
      }
    }
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  await processMessageIds([...newIds], client, config, result);
  return latestHistoryId;
}

export async function runGmailSync(args: {
  config: Config;
  client: GmailClient;
  force?: boolean;
}): Promise<SyncResult> {
  const { config, client } = args;
  const result: SyncResult = {
    status: "ok",
    fetched: 0,
    inserted: 0,
    skippedExisting: 0,
    skippedNewsletter: 0,
    errors: 0,
    historyIdAfter: null,
  };

  const state = await loadOrInitState();
  if (state.get("pausedAt") && !args.force) {
    return {
      ...result,
      status: "paused",
      message: (state.get("lastError") as string | null) ?? "paused",
    };
  }

  const startHistoryId = state.get("historyId") as string | null;
  try {
    const after = startHistoryId
      ? await incremental(startHistoryId, client, config, result)
      : await bootstrap(client, config, result);
    result.historyIdAfter = after;
    await recordSuccessfulRun(after);
    return result;
  } catch (err) {
    if (err instanceof OAuthError) {
      if (err.code === "invalid_grant") {
        await pauseWith("invalid_grant");
        return {
          ...result,
          status: "paused",
          message: "invalid_grant — re-grant required",
        };
      }
      if (err.code === "no_grant") {
        await recordIdleRun();
        return {
          ...result,
          status: "no_grant",
          message: "no Google OAuth grant on file",
        };
      }
      if (err.code === "kao_unauthorized") {
        // Kao 401 — bearer rejected. Stable label matches the status
        // route's `reason: "kao_unauthorized"` so the dashboard's OAuth
        // card and Gmail card show the same diagnostic for the same root
        // cause (wrong KAO_TOKEN).
        await recordFailedRun("kao_unauthorized");
        logger.error({ error: err, provider: "gmail" }, "gmail sync: kao unauthorized");
        return { ...result, status: "error", message: "kao_unauthorized" };
      }
      if (err.code === "refresh_failed") {
        // Kao unreachable / 5xx / misconfigured (wrong-host 404 — not
        // bad-bearer 401, which has its own branch above). Record a stable
        // label so the dashboard's `lastError` column stays fingerprint-
        // friendly across transient Kao blips rather than churning verbose
        // Kao internal strings (e.g. "Kao token fetch failed: ECONNREFUSED").
        await recordFailedRun("kao_unreachable");
        logger.error({ error: err, provider: "gmail" }, "gmail sync: kao unreachable");
        return { ...result, status: "error", message: "kao_unreachable" };
      }
    }
    if (err instanceof GmailHttpError && err.status === 401) {
      await pauseWith("invalid_grant");
      return {
        ...result,
        status: "paused",
        message: "gmail returned 401 — re-grant required",
      };
    }
    if (err instanceof GmailHttpError && err.status === 403) {
      // Google 403 after the client's self-heal retry — quota /
      // dailyLimitExceeded / scope misalignment that survived a fresh
      // token. Stable label so the dashboard doesn't churn the verbose
      // 300-char Google JSON body across retries (which would explode
      // Kansoku error fingerprinting). Verbose detail goes to the log,
      // not to SyncState.lastError.
      await recordFailedRun("google_403");
      logger.error(
        { error: err, body: err.body.slice(0, 500), provider: "gmail" },
        "gmail sync: google 403 (quota or scope)",
      );
      return { ...result, status: "error", message: "google_403" };
    }
    const progress = {
      provider: "gmail",
      startHistoryId,
      fetched: result.fetched,
      inserted: result.inserted,
      errors: result.errors,
    };
    if (err instanceof GoogleRequestTimeoutError) {
      await recordFailedRun(err.code);
      logger.error({ error: err, code: err.code, ...progress }, "gmail sync timed out");
      return { ...result, status: "error", message: err.code };
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordFailedRun(message);
    logger.error({ error: err, ...progress }, "gmail sync failed");
    return { ...result, status: "error", message };
  }
}

// Wire-up: vend Google access tokens via Kao. The `{ force }` hop lets the
// client recover from a mid-window Google revocation without restarting.
export async function runGmailSyncOnce(config: Config): Promise<SyncResult> {
  const { makeGmailClient } = await import("./gmail-client.js");
  const { getAccessToken } = await import("../lib/kao-client.js");
  const client = makeGmailClient((options) => getAccessToken(config, options));
  return runGmailSync({ config, client });
}
