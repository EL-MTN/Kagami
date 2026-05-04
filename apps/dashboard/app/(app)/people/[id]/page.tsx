import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError, config } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/format';
import { Button } from '@/components/ui/button';
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

function isOutbound(
  i: Interaction,
  userEmails: string[],
  peopleById: Map<string, Person>,
): boolean {
  const fromParticipants = i.participants.filter((p) => p.role === 'from');
  for (const p of fromParticipants) {
    const fromPerson = peopleById.get(p.personId);
    if (
      fromPerson?.primaryEmail &&
      userEmails.includes(fromPerson.primaryEmail.toLowerCase())
    ) {
      return true;
    }
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
  const participantsById = new Map<string, Person>();

  try {
    person = await api.getPerson(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <div className="space-y-6">
        <PageHeader title="Person" />
        <ErrorBlock
          title="Couldn't load person"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
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
      <div className="space-y-6">
        <PageHeader title={person.displayName} />
        <ErrorBlock
          title="Couldn't load related data"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={person.displayName}
        description={[
          person.relationship,
          org ? `@ ${org.name}` : null,
          person.primaryEmail,
        ]
          .filter(Boolean)
          .join(' · ')}
        meta={
          <div className="flex items-center gap-2">
            {person.deletedAt ? <Badge tone="red">tombstoned</Badge> : null}
            <Mono>{person.id}</Mono>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="space-y-6 md:col-span-2">
          <Card>
            <CardHeader>Interactions</CardHeader>
            <FilterBar sp={sp} basePath={`/people/${person.id}`} />
            {interactions.items.length === 0 ? (
              <div className="p-4">
                <Empty>No interactions match these filters.</Empty>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {interactions.items.map((i) => (
                  <li key={i.id} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <ChannelBadge channel={i.channel} />
                        {i.status !== 'active' ? (
                          <StatusBadge status={i.status} />
                        ) : null}
                        {(() => {
                          const lookup = new Map(participantsById);
                          lookup.set(person.id, person);
                          return isOutbound(i, config.userEmails, lookup) ? (
                            <Badge tone="blue">outbound</Badge>
                          ) : (
                            <Badge tone="zinc">inbound</Badge>
                          );
                        })()}
                        <span className="tabular-nums">
                          {fmtDateTime(i.occurredAt)}
                        </span>
                      </div>
                      <Mono>{i.source}</Mono>
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-foreground">
                      {i.title}
                    </p>
                    {i.body ? (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {i.body}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {i.participants
                        .filter((p) => p.personId !== person.id)
                        .map((p) => {
                          const other = participantsById.get(p.personId);
                          return (
                            <span key={p.personId + p.role}>
                              <span className="text-faint">{p.role}:</span>{' '}
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
                              className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent"
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

          <details className="group rounded-xl border border-border bg-card">
            <summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Raw JSON
            </summary>
            <pre className="overflow-x-auto border-t border-border bg-muted px-5 py-3 font-mono text-xs text-muted-foreground">
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
              <ul className="divide-y divide-border">
                {followups.items.map((f: Followup) => (
                  <li key={f.id} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <DirectionBadge direction={f.direction} />
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {f.dueAt ? fmtRelative(f.dueAt) : 'no due date'}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {f.reason}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader>Detail</CardHeader>
            <dl className="grid grid-cols-3 gap-y-2.5 px-5 py-4 text-sm">
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
              <Detail label="Tags" value={person.tags.join(', ') || '—'} />
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
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="col-span-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
        {label}
      </dt>
      <dd className="col-span-2 break-words text-foreground">{value}</dd>
    </>
  );
}

function FilterBar({ sp, basePath }: { sp: Search; basePath: string }) {
  const inputCls =
    'h-8 rounded-md border border-border bg-card px-2 text-xs transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40';
  return (
    <form
      action={basePath}
      method="get"
      className="flex flex-wrap gap-2 border-b border-border px-5 py-3"
    >
      <select name="channel" defaultValue={sp.channel ?? ''} className={inputCls}>
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
        className={inputCls}
      >
        <option value="active">active</option>
        <option value="cancelled">cancelled</option>
        <option value="any">any status</option>
      </select>
      <input
        type="date"
        name="occurredAfter"
        defaultValue={sp.occurredAfter?.slice(0, 10) ?? ''}
        className={inputCls}
      />
      <input
        type="date"
        name="occurredBefore"
        defaultValue={sp.occurredBefore?.slice(0, 10) ?? ''}
        className={inputCls}
      />
      <Button type="submit" variant="outline" size="sm">
        Filter
      </Button>
    </form>
  );
}
