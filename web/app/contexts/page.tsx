import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Interaction, Person } from '@/lib/types';
import {
  Card,
  CardHeader,
  ChannelBadge,
  Empty,
  ErrorBlock,
  PageHeader,
  PersonLink,
} from '../ui';

export const dynamic = 'force-dynamic';

const SAMPLE_LIMIT = 200;

type Search = { tag?: string };

export default async function ContextsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  let interactions: Awaited<ReturnType<typeof api.listInteractions>>;
  try {
    interactions = await api.listInteractions(
      sp.tag
        ? { context: sp.tag, limit: SAMPLE_LIMIT }
        : { limit: SAMPLE_LIMIT },
    );
  } catch (err) {
    return (
      <>
        <PageHeader title="Contexts" />
        <ErrorBlock
          title="Couldn't load interactions"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  if (sp.tag) {
    return (
      <ContextDetail tag={sp.tag} interactions={interactions.items} />
    );
  }

  // Aggregate distinct context tags + counts from the recent sample.
  const counts = new Map<string, number>();
  for (const i of interactions.items) {
    for (const c of i.context) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHeader
        title="Contexts"
        subtitle={`Aggregated from the last ${interactions.items.length} interactions. (Real distinct-aggregate endpoint is a roadmap item.)`}
      />
      {sorted.length === 0 ? (
        <Empty>No context tags in the recent sample.</Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-zinc-100">
            {sorted.map(([tag, count]) => (
              <li key={tag} className="flex items-center justify-between px-4 py-3">
                <Link
                  href={`/contexts?tag=${encodeURIComponent(tag)}`}
                  className="font-mono text-sm text-zinc-800 hover:underline"
                >
                  {tag}
                </Link>
                <span className="text-sm text-zinc-500">{count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

async function ContextDetail({
  tag,
  interactions,
}: {
  tag: string;
  interactions: Interaction[];
}) {
  const personIds = new Set<string>();
  for (const i of interactions) for (const p of i.participants) personIds.add(p.personId);
  const people = await Promise.all(
    [...personIds].map((id) => api.getPerson(id).catch(() => null)),
  );
  const personById = new Map<string, Person>();
  for (const p of people) if (p) personById.set(p.id, p);

  const implied = [...personById.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return (
    <>
      <PageHeader
        title={tag}
        subtitle={`${interactions.length} interactions · ${implied.length} implied participants`}
        right={
          <Link href="/contexts" className="text-zinc-500 hover:text-zinc-900">
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
              <ul className="divide-y divide-zinc-100">
                {interactions.map((i) => (
                  <li key={i.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <ChannelBadge channel={i.channel} />
                      <span>{fmtDateTime(i.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-zinc-900">
                      {i.title}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {i.participants
                        .map(
                          (p) =>
                            personById.get(p.personId)?.displayName ?? '?',
                        )
                        .join(', ')}
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
              <ul className="divide-y divide-zinc-100">
                {implied.map((p) => (
                  <li key={p.id} className="px-4 py-2 text-sm">
                    <PersonLink id={p.id} name={p.displayName} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
