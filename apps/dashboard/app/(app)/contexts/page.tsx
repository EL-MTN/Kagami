import Link from "next/link";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import type { Interaction, Person } from "@/lib/types";
import { Card, CardHeader, ChannelBadge, Empty, ErrorBlock, PageHeader, PersonLink } from "../ui";

export const dynamic = "force-dynamic";

type Search = { tag?: string };

export default async function ContextsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;

  if (sp.tag) {
    return <ContextDetail tag={sp.tag} />;
  }

  let result;
  try {
    result = await api.listContexts({ limit: 200 });
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title="Contexts" />
        <ErrorBlock
          title="Couldn't load contexts"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contexts"
        description={`${result.items.length} distinct context tags across active interactions.`}
      />
      {result.items.length === 0 ? (
        <Empty>No context tags yet.</Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {result.items.map((row) => (
              <li
                key={row.tag}
                className="flex items-center justify-between px-5 py-3 transition-colors hover:bg-accent/50"
              >
                <Link
                  href={`/contexts?tag=${encodeURIComponent(row.tag)}`}
                  className="font-mono text-sm text-foreground transition-colors hover:text-primary"
                >
                  {row.tag}
                </Link>
                <span className="text-sm tabular-nums text-muted-foreground">{row.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

async function ContextDetail({ tag }: { tag: string }) {
  let interactions: Interaction[];
  try {
    const res = await api.listInteractions({ context: tag, limit: 200 });
    interactions = res.items;
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title={tag} />
        <ErrorBlock
          title="Couldn't load interactions"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  const personIds = new Set<string>();
  for (const i of interactions) for (const p of i.participants) personIds.add(p.personId);
  const people = await Promise.all([...personIds].map((id) => api.getPerson(id).catch(() => null)));
  const personById = new Map<string, Person>();
  for (const p of people) if (p) personById.set(p.id, p);

  const implied = [...personById.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={tag}
        description={`${interactions.length} interactions · ${implied.length} implied participants`}
        meta={
          <Link
            href="/contexts"
            className="text-sm text-faint transition-colors hover:text-primary"
          >
            ← all contexts
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <Card>
            <CardHeader>Interactions</CardHeader>
            {interactions.length === 0 ? (
              <div className="p-4">
                <Empty>No interactions tagged with this context.</Empty>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {interactions.map((i) => (
                  <li key={i.id} className="px-5 py-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <ChannelBadge channel={i.channel} />
                      <span className="tabular-nums">{fmtDateTime(i.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-foreground">{i.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {i.participants
                        .map((p) => personById.get(p.personId)?.displayName ?? "?")
                        .join(", ")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside>
          <Card>
            <CardHeader>Implied participants</CardHeader>
            {implied.length === 0 ? (
              <div className="p-4">
                <Empty>No participants.</Empty>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {implied.map((p) => (
                  <li key={p.id} className="px-5 py-2.5 text-sm">
                    <PersonLink id={p.id} name={p.displayName} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
