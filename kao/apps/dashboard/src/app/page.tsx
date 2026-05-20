import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader, ErrorBlock } from "@/components/shell";
import { GrantBadge } from "@/components/grant-badge";
import { RevokeButton } from "@/components/revoke-button";
import { listGrants, oauthStartUrl, KAO_API_BASE, type GrantStatus } from "@/lib/api";
import { formatRelative } from "@/lib/format";

// Always render fresh — the data shape is tiny (one row per registry grant)
// and operators visiting this page after a Connect/Revoke want to see the new
// state, not a stale render.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  let grants: GrantStatus[];
  try {
    grants = await listGrants();
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Grants"
          description="Per-consumer Google OAuth grants. Each is consented for only the scopes that consumer needs."
        />
        <ErrorBlock
          title="Couldn't reach the Kao API"
          detail={err instanceof Error ? err.message : String(err)}
        />
        <p className="text-xs text-faint">
          Check that <code className="font-mono">{KAO_API_BASE}</code> is up and the
          dashboard&rsquo;s <code className="font-mono">KAO_TOKEN</code> matches the API.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Grants"
        description="Per-consumer Google OAuth grants. Each is consented for only the scopes that consumer needs."
      />

      <section className="stagger space-y-3">
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The grant registry is empty. Add a consumer in{" "}
            <code className="font-mono">kao/apps/api/src/grant-registry.ts</code>.
          </p>
        ) : (
          grants.map((g) => <GrantCard key={g.name} grant={g} />)
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-5 text-[11px] tabular-nums text-faint">
        <div className="grid grid-cols-[140px_1fr] gap-4">
          <span>API base</span>
          <span className="font-mono text-foreground">{KAO_API_BASE}</span>
        </div>
      </section>
    </div>
  );
}

function GrantCard({ grant }: { grant: GrantStatus }) {
  return (
    <article className="rounded-lg border border-border bg-card p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link
              href={`/grants/${grant.name}`}
              className="group inline-flex items-baseline gap-2 font-display text-2xl text-foreground transition-colors hover:text-primary"
            >
              {grant.name}
              <ArrowRight
                className="h-4 w-4 self-center text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                strokeWidth={1.75}
              />
            </Link>
            <GrantBadge grant={grant} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {grant.granted && grant.grantedAt ? (
              <>
                Connected <span className="tabular-nums">{formatRelative(grant.grantedAt)}</span>
              </>
            ) : grant.revokedAt ? (
              <>
                Revoked <span className="tabular-nums">{formatRelative(grant.revokedAt)}</span>
              </>
            ) : (
              <>No refresh token on file.</>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <a
            href={oauthStartUrl(grant.name)}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {grant.granted ? "Re-consent" : "Connect Google"}
          </a>
          <RevokeButton grant={grant.name} granted={grant.granted} />
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {grant.scopes.map((s) => (
          <code
            key={s}
            className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {scopeShorthand(s)}
          </code>
        ))}
      </div>
    </article>
  );
}

// Scope URIs are long and not where the operator's eyes should land first.
// Strip the constant prefix for the overview chip — the per-grant page still
// shows the full URI in its scopes list.
function scopeShorthand(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");
}
