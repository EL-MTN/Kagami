import { api, oauthStartUrl } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
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

export default async function SyncPage() {
  let status;
  try {
    status = await api.oauthStatus();
  } catch (err) {
    return (
      <>
        <PageHeader title="Sync" />
        <ErrorBlock
          title="Couldn't load OAuth status"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Sync"
        subtitle="Google OAuth grant + ingest worker state."
      />

      <Card>
        <CardHeader>Google OAuth</CardHeader>
        <div className="space-y-3 px-4 py-4 text-sm">
          {status.granted ? (
            <>
              <div className="flex items-center gap-2">
                <Badge tone="green">granted</Badge>
                <span className="text-zinc-600">
                  on {fmtDateTime(status.grantedAt)}
                </span>
              </div>
              <div className="text-xs text-zinc-500">scopes:</div>
              <ul className="space-y-1">
                {status.scopes.map((s) => (
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
          <CardHeader>Ingest workers</CardHeader>
          <div className="p-4">
            <Empty>
              Gmail and Calendar workers ship in step 5 + 6. Once they
              populate <Mono>sync_state</Mono>, this card will show last-run
              timestamp, history cursor, error counts, and pause status.
            </Empty>
          </div>
        </Card>
      </div>
    </>
  );
}
