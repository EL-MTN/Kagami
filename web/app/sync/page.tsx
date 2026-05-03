import { revalidatePath } from 'next/cache';
import { api, oauthStartUrl } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import type { SyncState } from '@/lib/types';
import {
  Badge,
  Card,
  CardHeader,
  Empty,
  ErrorBlock,
  Mono,
  PageHeader,
} from '../ui';

export const dynamic = 'force-dynamic';

async function runGmailSyncAction(formData: FormData) {
  'use server';
  const force = formData.get('force') === 'true';
  await api.runGmailSync(force);
  revalidatePath('/sync');
}

async function runGcalSyncAction(formData: FormData) {
  'use server';
  const force = formData.get('force') === 'true';
  await api.runGcalSync(force);
  revalidatePath('/sync');
}

export default async function SyncPage() {
  let oauth, gmailState, gcalState;
  try {
    [oauth, gmailState, gcalState] = await Promise.all([
      api.oauthStatus(),
      api.gmailSyncState(),
      api.gcalSyncState(),
    ]);
  } catch (err) {
    return (
      <>
        <PageHeader title="Sync" />
        <ErrorBlock
          title="Couldn't load sync status"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Sync"
        subtitle="Google OAuth grant + Gmail / Calendar ingest state."
      />

      <Card>
        <CardHeader>Google OAuth</CardHeader>
        <div className="space-y-3 px-4 py-4 text-sm">
          {oauth.granted ? (
            <>
              <div className="flex items-center gap-2">
                <Badge tone="green">granted</Badge>
                <span className="text-zinc-600">
                  on {fmtDateTime(oauth.grantedAt)}
                </span>
              </div>
              <div className="text-xs text-zinc-500">scopes:</div>
              <ul className="space-y-1">
                {oauth.scopes.map((s) => (
                  <li key={s}>
                    <Mono>{s}</Mono>
                  </li>
                ))}
              </ul>
              <div className="pt-2">
                <a
                  href={oauthStartUrl()}
                  className="inline-flex items-center rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
                >
                  Re-authorize
                </a>
                <p className="mt-1 text-xs text-zinc-500">
                  Use this if Google revoked access (
                  <Mono>invalid_grant</Mono>) or to add scopes.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Badge tone="amber">not granted</Badge>
                <span className="text-zinc-600">
                  Connect a Google account to enable Gmail + Calendar ingest.
                </span>
              </div>
              <div className="pt-2">
                <a
                  href={oauthStartUrl()}
                  className="inline-flex items-center rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                >
                  Connect Google
                </a>
              </div>
            </>
          )}
        </div>
      </Card>

      <div className="mt-6">
        <IngestCard
          title="Gmail ingest"
          state={gmailState}
          cursorLabel="History cursor"
          cursorValue={gmailState.historyId}
          granted={oauth.granted}
          action={runGmailSyncAction}
          bootstrappedWhen="historyId"
        />
      </div>

      <div className="mt-6">
        <IngestCard
          title="Calendar ingest"
          state={gcalState}
          cursorLabel="Sync token"
          cursorValue={gcalState.syncToken}
          granted={oauth.granted}
          action={runGcalSyncAction}
          bootstrappedWhen="syncToken"
        />
      </div>
    </>
  );
}

function IngestCard({
  title,
  state,
  cursorLabel,
  cursorValue,
  granted,
  action,
  bootstrappedWhen,
}: {
  title: string;
  state: SyncState;
  cursorLabel: string;
  cursorValue: string | null;
  granted: boolean;
  action: (fd: FormData) => Promise<void>;
  bootstrappedWhen: 'historyId' | 'syncToken';
}) {
  const isBootstrapped = Boolean(cursorValue);
  return (
    <Card>
      <CardHeader>{title}</CardHeader>
      <div className="space-y-4 px-4 py-4 text-sm">
        <div className="grid grid-cols-2 gap-y-2">
          <div className="text-zinc-500">Status</div>
          <div>
            {state.pausedAt ? (
              <Badge tone="red">paused</Badge>
            ) : isBootstrapped ? (
              <Badge tone="green">incremental</Badge>
            ) : (
              <Badge tone="amber">not bootstrapped</Badge>
            )}
          </div>
          <div className="text-zinc-500">Last run</div>
          <div>
            {state.lastRunAt ? (
              <>
                <span>{fmtDateTime(state.lastRunAt)}</span>{' '}
                <span className="text-zinc-400">
                  ({fmtRelative(state.lastRunAt)})
                </span>
              </>
            ) : (
              <span className="text-zinc-400">never</span>
            )}
          </div>
          <div className="text-zinc-500">{cursorLabel}</div>
          <div>
            {cursorValue ? (
              <Mono>{cursorValue}</Mono>
            ) : (
              <span className="text-zinc-400">—</span>
            )}
          </div>
          <div className="text-zinc-500">Error count</div>
          <div>{state.errorCount}</div>
          {state.lastError ? (
            <>
              <div className="text-zinc-500">Last error</div>
              <div className="text-rose-700">
                <Mono>{state.lastError}</Mono>
              </div>
            </>
          ) : null}
          {state.pausedAt ? (
            <>
              <div className="text-zinc-500">Paused at</div>
              <div>{fmtDateTime(state.pausedAt)}</div>
            </>
          ) : null}
        </div>

        {granted ? (
          <form action={action} className="flex items-center gap-2">
            {state.pausedAt ? (
              <>
                <input type="hidden" name="force" value="true" />
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
                >
                  Force-run (clear pause)
                </button>
                <span className="text-xs text-zinc-500">
                  Try after a Re-authorize.
                </span>
              </>
            ) : (
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Run sync now
              </button>
            )}
          </form>
        ) : (
          <Empty>Connect Google above before running ingest.</Empty>
        )}
        {bootstrappedWhen === 'syncToken' && state.lastError === 'invalid_grant' ? null : null}
      </div>
    </Card>
  );
}
