import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader, ErrorBlock } from "@/components/shell";
import { GrantBadge } from "@/components/grant-badge";
import { RevokeButton } from "@/components/revoke-button";
import { TokenProbe } from "@/components/token-probe";
import { ApiError, getGrant, oauthStartUrl, type GrantStatus } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";

// One row per grant in the registry. Page only renders for names the API
// recognizes — anything else 404s out of getGrant and we forward that to
// Next's notFound() so the URL space stays tight.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ grant: string }>;
}

export default async function GrantDetailPage({ params }: PageProps) {
  const { grant: name } = await params;

  let grant: GrantStatus;
  try {
    grant = await getGrant(name);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    return (
      <div className="space-y-6">
        <BackLink />
        <PageHeader title={name} />
        <ErrorBlock
          title="Couldn't load grant"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <BackLink />

      <PageHeader
        title={grant.name}
        description="Per-consumer Google OAuth grant."
        meta={<GrantBadge grant={grant} />}
      />

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h3 className="kicker">audit</h3>
        </div>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2.5 px-5 py-4 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <GrantBadge grant={grant} />
          </dd>

          <dt className="text-muted-foreground">Granted at</dt>
          <dd className="tabular-nums">
            {grant.grantedAt ? (
              <>
                <span>{formatDateTime(grant.grantedAt)}</span>{" "}
                <span className="text-faint">({formatRelative(grant.grantedAt)})</span>
              </>
            ) : (
              <span className="text-faint">never</span>
            )}
          </dd>

          {grant.revokedAt ? (
            <>
              <dt className="text-muted-foreground">Revoked at</dt>
              <dd className="tabular-nums">
                <span>{formatDateTime(grant.revokedAt)}</span>{" "}
                <span className="text-faint">({formatRelative(grant.revokedAt)})</span>
              </dd>
            </>
          ) : null}
        </dl>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <a
            href={oauthStartUrl(grant.name)}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {grant.granted ? "Re-consent" : "Connect Google"}
          </a>
          <RevokeButton grant={grant.name} granted={grant.granted} />
          <p className="ml-auto text-xs text-faint">
            Re-consent overwrites the stored refresh token and best-effort-revokes the previous one
            at Google.
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h3 className="kicker">scopes</h3>
        </div>
        <ul className="divide-y divide-border">
          {grant.scopes.map((s) => (
            <li key={s} className="px-5 py-2.5 font-mono text-xs text-foreground">
              {s}
            </li>
          ))}
        </ul>
        <p className="border-t border-border px-5 py-3 text-xs text-faint">
          Sourced from <code className="font-mono">grant-registry.ts</code> — never from the consent
          request.
        </p>
      </section>

      <TokenProbe grant={grant.name} granted={grant.granted} />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} /> All grants
    </Link>
  );
}
