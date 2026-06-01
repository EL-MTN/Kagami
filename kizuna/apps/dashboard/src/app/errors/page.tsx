import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { api } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import type { SyncState } from "@/lib/types";
import { Badge, Card, CardHeader, Empty, ErrorBlock, Mono, PageHeader } from "../ui";

export const dynamic = "force-dynamic";

type Severity = "paused" | "error" | "transient";

const SEVERITY_TONE: Record<Severity, "red" | "amber" | "zinc"> = {
  paused: "red",
  error: "amber",
  transient: "zinc",
};

function SyncLink({ children }: { children: ReactNode }) {
  return (
    <Link
      href="/sync"
      className="text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-rule-strong hover:text-primary"
    >
      {children}
    </Link>
  );
}

// Maps the stable `SyncState.lastError` codes the ingest workers write
// (see apps/api/src/ingest/{gmail,calendar}.ts) to a plain-English summary
// and an actionable next step. Unknown codes fall through to a generic case
// and the raw code is still shown verbatim above the summary.
function decodeError(code: string): {
  severity: Severity;
  summary: string;
  remediation: ReactNode;
} {
  switch (code) {
    case "invalid_grant":
      return {
        severity: "paused",
        summary:
          "Google rejected the stored credentials, so ingest is paused until it is re-authorized.",
        remediation: (
          <>
            Re-authorize Google on the <SyncLink>Sync page</SyncLink>, then use{" "}
            <Mono>Force-run</Mono> to clear the pause.
          </>
        ),
      };
    case "kao_unauthorized":
      return {
        severity: "error",
        summary: "Kao rejected Kizuna's bearer token — no Google access token could be vended.",
        remediation: (
          <>
            Check <Mono>KAO_TOKEN</Mono> in <Mono>apps/api/.env</Mono>. Re-running a sync won&apos;t
            help until it&apos;s fixed.
          </>
        ),
      };
    case "kao_unreachable":
      return {
        severity: "error",
        summary:
          "Couldn't reach Kao to vend a Google token (it's down, returned a 5xx, or KAO_URL is wrong).",
        remediation: (
          <>
            Verify Kao is running and <Mono>KAO_URL</Mono> is correct. The next scheduled tick
            retries automatically.
          </>
        ),
      };
    case "google_403":
      return {
        severity: "error",
        summary:
          "Google returned 403 even after a fresh token — usually an API quota cap or a scope mismatch.",
        remediation: (
          <>
            Check the Google project&apos;s quota; if scopes changed, re-authorize on the{" "}
            <SyncLink>Sync page</SyncLink>. The full response body is in the worker logs.
          </>
        ),
      };
    case "gmail_request_timeout":
    case "gcal_request_timeout":
      return {
        severity: "transient",
        summary:
          "A Google request exceeded the 30-second timeout. The cursor was preserved, so nothing was skipped.",
        remediation: (
          <>
            Usually transient — the next tick retries from the same point. No action needed unless
            it keeps recurring.
          </>
        ),
      };
    default:
      return {
        severity: "error",
        summary: "The worker hit an unexpected error; the raw code is shown above.",
        remediation: <>Check the worker logs (or Kansoku) for the full stack trace.</>,
      };
  }
}

// errorCount is monotonic (reset only on re-authorize), so a non-zero count is
// not by itself a live problem — the active signal is a current lastError or a
// pause. See kizuna/docs/sync.md.
function hasIssue(state: SyncState): boolean {
  return state.pausedAt !== null || state.lastError !== null;
}

function LastRun({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-faint">never</span>;
  return (
    <>
      <span>{fmtDateTime(iso)}</span> <span className="text-faint">({fmtRelative(iso)})</span>
    </>
  );
}

export default async function ErrorsPage() {
  let granted: boolean;
  let gmailState: SyncState;
  let gcalState: SyncState;
  try {
    const [oauth, gmail, gcal] = await Promise.all([
      api.oauthStatus(),
      api.gmailSyncState(),
      api.gcalSyncState(),
    ]);
    granted = oauth.granted;
    gmailState = gmail;
    gcalState = gcal;
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title="Errors" />
        <ErrorBlock
          title="Couldn't load ingest health"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  const providers = [
    { key: "gmail", title: "Gmail ingest", state: gmailState },
    { key: "gcal", title: "Calendar ingest", state: gcalState },
  ] as const;
  const failing = providers.filter((p) => hasIssue(p.state));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Errors"
        description="Ingest worker health — paused syncs, recent failures, and how to clear them."
      />

      {failing.length === 0 ? (
        <Card>
          <CardHeader>Ingest workers</CardHeader>
          <div className="space-y-4 px-5 py-4 text-sm">
            <Empty>
              {granted ? (
                "No worker errors. Gmail and Calendar ingest are healthy."
              ) : (
                <>
                  No worker errors — but Google isn&apos;t connected, so ingest isn&apos;t running.{" "}
                  <SyncLink>Connect it on the Sync page</SyncLink>.
                </>
              )}
            </Empty>
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2.5">
              {providers.map((p) => (
                <Fragment key={p.key}>
                  <dt className="text-muted-foreground">{p.title} — last run</dt>
                  <dd className="tabular-nums">
                    <LastRun iso={p.state.lastRunAt} />
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </Card>
      ) : (
        failing.map((p) => <ErrorCard key={p.key} title={p.title} state={p.state} />)
      )}

      <Card>
        <CardHeader>About this page</CardHeader>
        <div className="space-y-2 px-5 py-4 text-sm text-muted-foreground">
          <p>
            Only persisted worker-level failures show up here — each provider keeps its latest{" "}
            <Mono>lastError</Mono>, pause state, and a cumulative error count in{" "}
            <Mono>SyncState</Mono>.
          </p>
          <p>
            Per-message and per-event ingest warnings (unresolved participants, parse failures)
            aren&apos;t persisted in Kizuna — they&apos;re counted per run and emitted to the logs /
            Kansoku. With <Mono>strict: &apos;throw&apos;</Mono> on every schema, malformed writes
            are rejected at insert time rather than stored.
          </p>
        </div>
      </Card>
    </div>
  );
}

function ErrorCard({ title, state }: { title: string; state: SyncState }) {
  // A pause is only ever set with lastError "invalid_grant"; default defensively.
  const decoded = decodeError(state.lastError ?? "invalid_grant");
  const severity: Severity = state.pausedAt ? "paused" : decoded.severity;

  return (
    <Card>
      <CardHeader>{title}</CardHeader>
      <div className="space-y-4 px-5 py-4 text-sm">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2.5">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <Badge tone={SEVERITY_TONE[severity]}>{severity}</Badge>
          </dd>
          <dt className="text-muted-foreground">Error code</dt>
          <dd>
            {state.lastError ? (
              <Mono>{state.lastError}</Mono>
            ) : (
              <span className="text-faint">—</span>
            )}
          </dd>
          <dt className="text-muted-foreground">What it means</dt>
          <dd className="text-foreground">{decoded.summary}</dd>
          <dt className="text-muted-foreground">Last run</dt>
          <dd className="tabular-nums">
            <LastRun iso={state.lastRunAt} />
          </dd>
          {state.pausedAt ? (
            <>
              <dt className="text-muted-foreground">Paused at</dt>
              <dd className="tabular-nums">
                <span>{fmtDateTime(state.pausedAt)}</span>{" "}
                <span className="text-faint">({fmtRelative(state.pausedAt)})</span>
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Errors logged</dt>
          <dd className="tabular-nums">
            {state.errorCount} <span className="text-faint">cumulative</span>
          </dd>
        </dl>

        <div className="rounded-md border border-border bg-muted/40 px-4 py-3">
          <div className="kicker">Next step</div>
          <p className="mt-1.5 text-foreground">{decoded.remediation}</p>
        </div>
      </div>
    </Card>
  );
}
