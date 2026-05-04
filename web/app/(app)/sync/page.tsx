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
      <div className="space-y-6">
        <PageHeader title="Sync" />
        <ErrorBlock
          title="Couldn't load sync status"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sync"
        description="Google OAuth grant + Gmail / Calendar ingest state."
      />

      <Card>
        <CardHeader>Google OAuth</CardHeader>
        <div className="space-y-3 px-5 py-4 text-sm">
          {oauth.granted ? (
            <>
              <div className="flex items-center gap-2">
                <Badge tone="green">granted</Badge>
                <span className="text-muted-foreground tabular-nums">
                  on {fmtDateTime(oauth.grantedAt)}
                </span>
              </div>
              <div className="kicker">scopes</div>
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
                  className="inline-flex h-9 items-center rounded-md border border-border bg-card px-3 text-sm shadow-xs transition-colors hover:bg-accent"
                >
                  Re-authorize
                </a>
                <p className="mt-1.5 text-xs text-faint">
                  Use this if Google revoked access (
                  <Mono>invalid_grant</Mono>) or to add scopes.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Badge tone="amber">not granted</Badge>
                <span className="text-muted-foreground">
                  Connect a Google account to enable Gmail + Calendar ingest.
                </span>
              </div>
              <div className="pt-2">
                <a
                  href={oauthStartUrl()}
                  className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Connect Google
                </a>
              </div>
            </>
          )}
        </div>
      </Card>

      <IngestCard
        title="Gmail ingest"
        state={gmailState}
        cursorLabel="History cursor"
        cursorValue={gmailState.historyId}
        granted={oauth.granted}
        action={runGmailSyncAction}
      />

      <IngestCard
        title="Calendar ingest"
        state={gcalState}
        cursorLabel="Sync token"
        cursorValue={gcalState.syncToken}
        granted={oauth.granted}
        action={runGcalSyncAction}
      />
    </div>
  );
}

function IngestCard({
  title,
  state,
  cursorLabel,
  cursorValue,
  granted,
  action,
}: {
  title: string;
  state: SyncState;
  cursorLabel: string;
  cursorValue: string | null;
  granted: boolean;
  action: (fd: FormData) => Promise<void>;
}) {
  const isBootstrapped = Boolean(cursorValue);
  return (
    <Card>
      <CardHeader>{title}</CardHeader>
      <div className="space-y-4 px-5 py-4 text-sm">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            {state.pausedAt ? (
              <Badge tone="red">paused</Badge>
            ) : isBootstrapped ? (
              <Badge tone="green">incremental</Badge>
            ) : (
              <Badge tone="amber">not bootstrapped</Badge>
            )}
          </dd>
          <dt className="text-muted-foreground">Last run</dt>
          <dd className="tabular-nums">
            {state.lastRunAt ? (
              <>
                <span>{fmtDateTime(state.lastRunAt)}</span>{' '}
                <span className="text-faint">
                  ({fmtRelative(state.lastRunAt)})
                </span>
              </>
            ) : (
              <span className="text-faint">never</span>
            )}
          </dd>
          <dt className="text-muted-foreground">{cursorLabel}</dt>
          <dd>
            {cursorValue ? (
              <Mono>{cursorValue}</Mono>
            ) : (
              <span className="text-faint">—</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Error count</dt>
          <dd className="tabular-nums">{state.errorCount}</dd>
          {state.lastError ? (
            <>
              <dt className="text-muted-foreground">Last error</dt>
              <dd className="text-critical">
                <Mono>{state.lastError}</Mono>
              </dd>
            </>
          ) : null}
          {state.pausedAt ? (
            <>
              <dt className="text-muted-foreground">Paused at</dt>
              <dd className="tabular-nums">{fmtDateTime(state.pausedAt)}</dd>
            </>
          ) : null}
        </dl>

        {granted ? (
          <form action={action} className="flex items-center gap-2">
            {state.pausedAt ? (
              <>
                <input type="hidden" name="force" value="true" />
                <button
                  type="submit"
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm font-medium shadow-xs transition-colors hover:bg-accent"
                >
                  Force-run (clear pause)
                </button>
                <span className="text-xs text-faint">
                  Try after a Re-authorize.
                </span>
              </>
            ) : (
              <button
                type="submit"
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Run sync now
              </button>
            )}
          </form>
        ) : (
          <Empty>Connect Google above before running ingest.</Empty>
        )}
      </div>
    </Card>
  );
}
