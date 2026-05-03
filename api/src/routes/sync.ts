import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { SyncState } from '../db/models/SyncState.js';
import { runGmailSyncOnce } from '../ingest/gmail.js';
import { errors } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { ISODateString } from '../schemas/common.js';
import type { EndpointSpec } from '../manifest.js';

export const SyncStateResponse = z.object({
  provider: z.enum(['gmail', 'gcal']),
  historyId: z.string().nullable(),
  syncToken: z.string().nullable(),
  lastRunAt: ISODateString.nullable(),
  errorCount: z.number(),
  lastError: z.string().nullable(),
  pausedAt: ISODateString.nullable(),
});

export const RunSyncResponse = z.object({
  status: z.enum(['ok', 'paused', 'no_grant', 'error']),
  fetched: z.number(),
  inserted: z.number(),
  skippedExisting: z.number(),
  skippedNewsletter: z.number(),
  errors: z.number(),
  historyIdAfter: z.string().nullable(),
  message: z.string().optional(),
});

export const RunSyncBody = z
  .object({ force: z.boolean().optional() })
  .strict();

export function makeSyncRouter(config: Config, logger: Logger): Router {
  const r = Router();

  r.get('/sync/gmail/state', async (_req, res) => {
    const doc = await SyncState.findOne({ provider: 'gmail' }).lean();
    if (!doc) {
      res.json({
        provider: 'gmail',
        historyId: null,
        syncToken: null,
        lastRunAt: null,
        errorCount: 0,
        lastError: null,
        pausedAt: null,
      });
      return;
    }
    res.json({
      provider: 'gmail',
      historyId: doc.historyId ?? null,
      syncToken: doc.syncToken ?? null,
      lastRunAt: doc.lastRunAt ?? null,
      errorCount: doc.errorCount ?? 0,
      lastError: doc.lastError ?? null,
      pausedAt: doc.pausedAt ?? null,
    });
  });

  r.post('/sync/gmail/run', async (req, res) => {
    const body = RunSyncBody.parse(req.body ?? {});
    if (!config.KIZUNA_OAUTH_ENCRYPTION_KEY) {
      throw errors.badRequest(
        'KIZUNA_OAUTH_ENCRYPTION_KEY is not set; cannot decrypt refresh token',
      );
    }
    const result = await runGmailSyncOnce(config, logger);
    if (body.force && result.status === 'paused') {
      // Caller asked to force; clear pause and rerun once.
      await SyncState.updateOne(
        { provider: 'gmail' },
        { $set: { pausedAt: null } },
      );
      const second = await runGmailSyncOnce(config, logger);
      res.json(second);
      return;
    }
    res.json(result);
  });

  return r;
}

export const syncEndpoints: EndpointSpec[] = [
  {
    name: 'get_gmail_sync_state',
    method: 'GET',
    path: '/v1/sync/gmail/state',
    description: 'Return the Gmail sync state (historyId, lastRunAt, errors, pause).',
    response: SyncStateResponse,
  },
  {
    name: 'run_gmail_sync',
    method: 'POST',
    path: '/v1/sync/gmail/run',
    description:
      'Run a Gmail sync pass synchronously. Bootstrap on first run; incremental thereafter. Returns counts + final historyId.',
    body: RunSyncBody,
    response: RunSyncResponse,
  },
];
