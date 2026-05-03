import { Card, Empty, PageHeader } from '../ui';

export const dynamic = 'force-dynamic';

export default function SyncPage() {
  return (
    <>
      <PageHeader
        title="Sync"
        subtitle="Last Gmail / Calendar pull, error counts, retry backoff, OAuth re-grant link."
      />
      <Card>
        <div className="p-6">
          <Empty>
            Ingest workers (Gmail, Calendar) ship in step 5 + 6. Once they
            populate <code className="font-mono text-xs">sync_state</code>,
            this page will show last-run timestamps, history cursor, error
            counts, and an OAuth re-grant link.
          </Empty>
        </div>
      </Card>
    </>
  );
}
