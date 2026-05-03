import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError, config } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/format';
import type { Followup, Interaction, Person } from '@/lib/types';
import {
  Badge,
  Card,
  CardHeader,
  ChannelBadge,
  DirectionBadge,
  Empty,
  ErrorBlock,
  Mono,
  PageHeader,
  PersonLink,
  StatusBadge,
} from '../../ui';

export const dynamic = 'force-dynamic';

type Search = {
  channel?: string;
  occurredBefore?: string;
  occurredAfter?: string;
  source?: string;
  status?: string;
};

function isOutbound(i: Interaction, person: Person, userEmails: string[]): boolean {
  // Heuristic: an interaction is outbound if the person whose role is `from`
  // has primaryEmail in USER_EMAILS — i.e. the user is the sender.
  // (Step 5 will tag this server-side once ingest writes provenance.)
  const fromIds = i.participants.filter((p) => p.role === 'from').map((p) => p.personId);
  if (fromIds.length === 0) return false;
  if (
    person.primaryEmail &&
    userEmails.includes(person.primaryEmail.toLowerCase()) &&
    fromIds.includes(person.id)
  ) {
    return true;
  }
  return false;
}

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  let person: Person;
  let interactions: Awaited<ReturnType<typeof api.getPersonInteractions>>;
  let followups: Awaited<ReturnType<typeof api.listFollowups>>;
  let org: Awaited<ReturnType<typeof api.getOrganization>> | null = null;
  let participantsById = new Map<string, Person>();

  try {
    person = await api.getPerson(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <>
        <PageHeader title="Person" />
        <ErrorBlock
          title="Couldn't load person"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  try {
    [interactions, followups] = await Promise.all([
      api.getPersonInteractions(id, {
        limit: 50,
        ...(sp.channel ? { channel: sp.channel } : {}),
        ...(sp.occurredBefore ? { occurredBefore: sp.occurredBefore } : {}),
        ...(sp.occurredAfter ? { occurredAfter: sp.occurredAfter } : {}),
        ...(sp.source ? { source: sp.source } : {}),
        ...(sp.status === 'any' || sp.status === 'cancelled'
          ? { status: sp.status }
          : {}),
      }),
      api.listFollowups({ personId: id, status: 'open', limit: 25 }),
    ]);
    if (person.primaryOrgId) {
      org = await api.getOrganization(person.primaryOrgId).catch(() => null);
    }
    const otherIds = new Set<string>();
    for (const i of interactions.items) {
      for (const p of i.participants) {
        if (p.personId !== person.id) otherIds.add(p.personId);
      }
    }
    const others = await Promise.all(
      [...otherIds].map((pid) => api.getPerson(pid).catch(() => null)),
    );
    for (const p of others) if (p) participantsById.set(p.id, p);
  } catch (err) {
    return (
      <>
        <PageHeader title={person.displayName} />
        <ErrorBlock
          title="Couldn't load related data"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={person.displayName}
        subtitle={[
          person.relationship,
          org ? `@ ${org.name}` : null,
          person.primaryEmail,
        ]
          .filter(Boolean)
          .join(' · ')}
        right={
          <div className="flex items-center gap-2">
            {person.deletedAt ? <Badge tone="red">tombstoned</Badge> : null}
            <Mono>{person.id}</Mono>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader>Interactions</CardHeader>
            <FilterBar sp={sp} basePath={`/people/${person.id}`} />
            {interactions.items.length === 0 ? (
              <div className="p-4">
                <Empty>No interactions match these filters.</Empty>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {interactions.items.map((i) => (
                  <li key={i.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-zinc-500">
                      <div className="flex items-center gap-2">
                        <ChannelBadge channel={i.channel} />
                        {i.status !== 'active' ? (
                          <StatusBadge status={i.status} />
                        ) : null}
                        {isOutbound(i, person, config.userEmails) ? (
                          <Badge tone="blue">outbound</Badge>
                        ) : (
                          <Badge tone="zinc">inbound</Badge>
                        )}
                        <span>{fmtDateTime(i.occurredAt)}</span>
                      </div>
                      <Mono>{i.source}</Mono>
                    </div>
                    <p className="mt-1 text-sm font-medium text-zinc-900">
                      {i.title}
                    </p>
                    {i.body ? (
                      <p className="mt-1 line-clamp-2 text-sm text-zinc-600">
                        {i.body}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      {i.participants
                        .filter((p) => p.personId !== person.id)
                        .map((p) => {
                          const other = participantsById.get(p.personId);
                          return (
                            <span key={p.personId + p.role}>
                              <span className="text-zinc-400">{p.role}:</span>{' '}
                              {other ? (
                                <PersonLink
                                  id={other.id}
                                  name={other.displayName}
                                />
                              ) : (
                                '?'
                              )}
                            </span>
                          );
                        })}
                      {i.context.length > 0 && (
                        <span className="ml-auto flex items-center gap-1">
                          {i.context.map((c) => (
                            <Link
                              key={c}
                              href={`/contexts?tag=${encodeURIComponent(c)}`}
                              className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-200"
                            >
                              {c}
                            </Link>
                          ))}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <details className="rounded-lg border border-zinc-200 bg-white">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-zinc-700">
              Raw JSON
            </summary>
            <pre className="overflow-x-auto border-t border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-700">
              {JSON.stringify(person, null, 2)}
            </pre>
          </details>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader>Open followups</CardHeader>
            {followups.items.length === 0 ? (
              <div className="p-4">
                <Empty>None open.</Empty>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {followups.items.map((f: Followup) => (
                  <li key={f.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <DirectionBadge direction={f.direction} />
                      <span className="text-xs text-zinc-500">
                        {f.dueAt ? fmtRelative(f.dueAt) : 'no due date'}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-zinc-700">{f.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader>Detail</CardHeader>
            <dl className="grid grid-cols-3 gap-y-2 px-4 py-3 text-sm">
              <Detail label="First seen" value={fmtDate(person.firstSeen)} />
              <Detail
                label="Last interaction"
                value={fmtDate(person.lastInteractionAt)}
              />
              <Detail label="Birthday" value={person.birthday ?? '—'} />
              <Detail label="Phones" value={person.phones.join(', ') || '—'} />
              <Detail
                label="Emails"
                value={person.emails.length ? person.emails.join(', ') : '—'}
              />
              <Detail
                label="Handles"
                value={
                  Object.keys(person.handles).length === 0
                    ? '—'
                    : Object.entries(person.handles)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(', ')
                }
              />
              <Detail
                label="Tags"
                value={person.tags.join(', ') || '—'}
              />
              <Detail label="Source" value={<Mono>{person.source}</Mono>} />
              <Detail
                label="suppressReingest"
                value={person.suppressReingest ? 'yes' : 'no'}
              />
              {person.notes ? (
                <Detail label="Notes" value={person.notes} />
              ) : null}
            </dl>
          </Card>
        </aside>
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="col-span-1 text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className="col-span-2 break-words text-zinc-800">{value}</dd>
    </>
  );
}

function FilterBar({ sp, basePath }: { sp: Search; basePath: string }) {
  return (
    <form action={basePath} method="get" className="flex flex-wrap gap-2 border-b border-zinc-100 px-4 py-3">
      <select
        name="channel"
        defaultValue={sp.channel ?? ''}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs"
      >
        <option value="">any channel</option>
        <option value="email">email</option>
        <option value="calendar">calendar</option>
        <option value="in_person">in_person</option>
        <option value="call">call</option>
        <option value="message">message</option>
        <option value="manual">manual</option>
      </select>
      <select
        name="status"
        defaultValue={sp.status ?? 'active'}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs"
      >
        <option value="active">active</option>
        <option value="cancelled">cancelled</option>
        <option value="any">any status</option>
      </select>
      <input
        type="date"
        name="occurredAfter"
        defaultValue={sp.occurredAfter?.slice(0, 10) ?? ''}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs"
      />
      <input
        type="date"
        name="occurredBefore"
        defaultValue={sp.occurredBefore?.slice(0, 10) ?? ''}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs"
      />
      <button
        type="submit"
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
      >
        Filter
      </button>
    </form>
  );
}
