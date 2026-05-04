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

type Search = { tag?: string };

export default async function ContextsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  if (sp.tag) {
    return <ContextDetail tag={sp.tag} />;
  }

  let result;
  try {
    result = await api.listContexts({ limit: 200 });
  } catch (err) {
    return (
      <>
        <PageHeader title="Contexts" />
        <ErrorBlock
          title="Couldn't load contexts"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Contexts"
        subtitle={`${result.items.length} distinct context tags across active interactions.`}
      />
      {result.items.length === 0 ? (
        <Empty>No context tags yet.</Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-zinc-100">
            {result.items.map((row) => (
              <li
                key={row.tag}
                className="flex items-center justify-between px-4 py-3"
              >
                <Link
                  href={`/contexts?tag=${encodeURIComponent(row.tag)}`}
                  className="font-mono text-sm text-zinc-800 hover:underline"
                >
                  {row.tag}
                </Link>
                <span className="text-sm text-zinc-500">{row.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

async function ContextDetail({ tag }: { tag: string }) {
  let interactions: Interaction[] = [];
  try {
    const res = await api.listInteractions({ context: tag, limit: 200 });
    interactions = res.items;
  } catch (err) {
    return (
      <>
        <PageHeader title={tag} />
        <ErrorBlock
          title="Couldn't load interactions"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  const personIds = new Set<string>();
  for (const i of interactions)
    for (const p of i.participants) personIds.add(p.personId);
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
