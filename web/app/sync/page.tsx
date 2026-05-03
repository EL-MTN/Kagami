import { revalidatePath } from 'next/cache';
import { api, oauthStartUrl } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
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

export default async function SyncPage() {
  let oauth, gmailState;
  try {
    [oauth, gmailState] = await Promise.all([
      api.oauthStatus(),
      api.gmailSyncState(),
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
        <Card>
          <CardHeader>Gmail ingest</CardHeader>
          <div className="space-y-4 px-4 py-4 text-sm">
            <div className="grid grid-cols-2 gap-y-2">
              <div className="text-zinc-500">Status</div>
              <div>
                {gmailState.pausedAt ? (
                  <Badge tone="red">paused</Badge>
                ) : gmailState.historyId ? (
                  <Badge tone="green">incremental</Badge>
                ) : (
                  <Badge tone="amber">not bootstrapped</Badge>
                )}
              </div>
              <div className="text-zinc-500">Last run</div>
              <div>
                {gmailState.lastRunAt ? (
                  <>
                    <span>{fmtDateTime(gmailState.lastRunAt)}</span>{' '}
                    <span className="text-zinc-400">
                      ({fmtRelative(gmailState.lastRunAt)})
                    </span>
                  </>
                ) : (
                  <span className="text-zinc-400">never</span>
                )}
              </div>
              <div className="text-zinc-500">History cursor</div>
              <div>
                {gmailState.historyId ? (
                  <Mono>{gmailState.historyId}</Mono>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </div>
              <div className="text-zinc-500">Error count</div>
              <div>{gmailState.errorCount}</div>
              {gmailState.lastError ? (
                <>
                  <div className="text-zinc-500">Last error</div>
                  <div className="text-rose-700">
                    <Mono>{gmailState.lastError}</Mono>
                  </div>
                </>
              ) : null}
              {gmailState.pausedAt ? (
                <>
                  <div className="text-zinc-500">Paused at</div>
                  <div>{fmtDateTime(gmailState.pausedAt)}</div>
                </>
              ) : null}
            </div>

            {oauth.granted ? (
              <form action={runGmailSyncAction} className="flex items-center gap-2">
                {gmailState.pausedAt ? (
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
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader>Calendar ingest</CardHeader>
          <div className="p-4">
            <Empty>
              Calendar worker ships in step 6. Once it populates{' '}
              <Mono>sync_state</Mono> for <Mono>gcal</Mono>, this card mirrors
              the Gmail one.
            </Empty>
          </div>
        </Card>
      </div>
    </>
  );
}
