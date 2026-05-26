import { revalidatePath } from "next/cache";
import { api, kaoConsentUrl, kaoDashboardUrl } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import type { SyncState } from "@/lib/types";
import { Badge, Card, CardHeader, ErrorBlock, Mono, PageHeader } from "../ui";

export const dynamic = "force-dynamic";

async function runGmailSyncAction(formData: FormData) {
  "use server";
  const force = formData.get("force") === "true";
  await api.runGmailSync(force);
  revalidatePath("/sync");
}

async function runGcalSyncAction(formData: FormData) {
  "use server";
  const force = formData.get("force") === "true";
  await api.runGcalSync(force);
  revalidatePath("/sync");
}

export default async function SyncPage() {
  let gmailState, gcalState;
  try {
    [gmailState, gcalState] = await Promise.all([api.gmailSyncState(), api.gcalSyncState()]);
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
        description="Gmail / Calendar ingest state. Google access is vended by Kao."
      />

      <Card>
        <CardHeader>Google access</CardHeader>
        <div className="space-y-3 px-5 py-4 text-sm">
          <p className="text-muted-foreground">
            Managed by the <Mono>Kao</Mono> identity service. Kizuna no longer owns a Google refresh
            token — it fetches short-lived access tokens from Kao on each ingest run. Grant /
            re-grant happens there.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button asChild>
              <a href={kaoConsentUrl()}>Grant / re-consent in Kao →</a>
            </Button>
            <Button variant="outline" asChild>
              <a href={kaoDashboardUrl()}>Open Kao dashboard</a>
            </Button>
          </div>
          <p className="text-xs text-faint">
            If an ingest run below shows <Mono>invalid_grant</Mono>, re-consent at Kao and then
            click Force-run on that worker to drop the stale cached token.
          </p>
        </div>
      </Card>

      <IngestCard
        title="Gmail ingest"
        state={gmailState}
        cursorLabel="History cursor"
        cursorValue={gmailState.historyId}
        action={runGmailSyncAction}
      />

      <IngestCard
        title="Calendar ingest"
        state={gcalState}
        cursorLabel="Sync token"
        cursorValue={gcalState.syncToken}
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
  action,
}: {
  title: string;
  state: SyncState;
  cursorLabel: string;
  cursorValue: string | null;
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
                <span>{fmtDateTime(state.lastRunAt)}</span>{" "}
                <span className="text-faint">({fmtRelative(state.lastRunAt)})</span>
              </>
            ) : (
              <span className="text-faint">never</span>
            )}
          </dd>
          <dt className="text-muted-foreground">{cursorLabel}</dt>
          <dd>
            {cursorValue ? <Mono>{cursorValue}</Mono> : <span className="text-faint">—</span>}
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

        {/*
          Ingest buttons are no longer gated on a dashboard-known "granted"
          flag — Kizuna can't cheaply know grant status now that Kao owns it.
          Runs without a valid grant surface as a no_grant / refresh_failed
          line in `lastError` above, which is the same signal the operator
          would have acted on anyway.
        */}
        <form action={action} className="flex items-center gap-2">
          {state.pausedAt ? (
            <>
              <input type="hidden" name="force" value="true" />
              <Button type="submit" variant="outline">
                Force-run (clear pause)
              </Button>
              <span className="text-xs text-faint">
                Try after re-consenting at Kao. Force-run also drops the cached access token.
              </span>
            </>
          ) : (
            <Button type="submit">Run sync now</Button>
          )}
        </form>
      </div>
    </Card>
  );
}
