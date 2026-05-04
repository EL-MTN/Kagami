import { Card, Empty, PageHeader } from '../ui';

export const dynamic = 'force-dynamic';

export default function ErrorsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Errors"
        description="Sync worker failures, unresolved participants, malformed-field rows."
      />
      <Card>
        <div className="p-6">
          <Empty>
            Wired up alongside the ingest workers in step 5+. With{' '}
            <code className="font-mono text-xs text-muted-foreground">
              strict: &apos;throw&apos;
            </code>{' '}
            on every schema, malformed writes are rejected at insert time
            rather than persisted, so &quot;malformed rows&quot; here will mean
            either ingest-side parse failures or unresolved participant
            references — both surfaced from the worker error logs.
          </Empty>
        </div>
      </Card>
    </div>
  );
}
