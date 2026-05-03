import { api } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import type { Followup, Interaction, Person } from '@/lib/types';
import {
  Card,
  CardHeader,
  ChannelBadge,
  DirectionBadge,
  Empty,
  ErrorBlock,
  PageHeader,
  PersonLink,
} from './ui';

export const dynamic = 'force-dynamic';

async function fetchData() {
  const now = new Date().toISOString();
  const [overdue, upcoming, recent] = await Promise.all([
    api.listFollowups({ status: 'open', dueBefore: now, limit: 25 }),
    api.listFollowups({ status: 'open', dueAfter: now, limit: 25 }),
    api.listInteractions({ limit: 15 }),
  ]);
  const personIds = new Set<string>();
  for (const f of [...overdue.items, ...upcoming.items]) personIds.add(f.personId);
  for (const i of recent.items) for (const p of i.participants) personIds.add(p.personId);
  const people = await Promise.all(
    [...personIds].map((id) => api.getPerson(id).catch(() => null)),
  );
  const personById = new Map<string, Person>();
  for (const p of people) if (p) personById.set(p.id, p);
  return { overdue, upcoming, recent, personById };
}

export default async function TodayPage() {
  let data: Awaited<ReturnType<typeof fetchData>>;
  try {
    data = await fetchData();
  } catch (err) {
    return (
      <>
        <PageHeader title="Today" />
        <ErrorBlock
          title="Couldn't reach the API"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  const { overdue, upcoming, recent, personById } = data;

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={`${overdue.items.length} overdue · ${upcoming.items.length} upcoming · ${recent.items.length} recent`}
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>Overdue followups</CardHeader>
          {overdue.items.length === 0 ? (
            <div className="p-4">
              <Empty>Nothing overdue.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {overdue.items.map((f) => (
                <FollowupRow key={f.id} f={f} person={personById.get(f.personId)} />
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>Upcoming followups</CardHeader>
          {upcoming.items.length === 0 ? (
            <div className="p-4">
              <Empty>Nothing scheduled.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {upcoming.items.map((f) => (
                <FollowupRow key={f.id} f={f} person={personById.get(f.personId)} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Recent interactions
        </h2>
        <Card>
          {recent.items.length === 0 ? (
            <div className="p-4">
              <Empty>No interactions yet. Run an ingest worker or POST one.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {recent.items.map((i) => (
                <InteractionRow key={i.id} i={i} personById={personById} />
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}

function FollowupRow({ f, person }: { f: Followup; person?: Person }) {
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <DirectionBadge direction={f.direction} />
          {person ? (
            <PersonLink id={person.id} name={person.displayName} />
          ) : (
            <span className="text-zinc-400">(unknown person)</span>
          )}
        </div>
        <p className="mt-1 truncate text-sm text-zinc-700">{f.reason}</p>
      </div>
      <div className="shrink-0 text-right text-xs text-zinc-500">
        {f.dueAt ? (
          <>
            <div>{fmtDateTime(f.dueAt)}</div>
            <div className="text-zinc-400">{fmtRelative(f.dueAt)}</div>
          </>
        ) : (
          <span className="text-zinc-400">no due date</span>
        )}
      </div>
    </li>
  );
}

function InteractionRow({
  i,
  personById,
}: {
  i: Interaction;
  personById: Map<string, Person>;
}) {
  const names = i.participants
    .slice(0, 3)
    .map((p) => personById.get(p.personId)?.displayName ?? '?')
    .join(', ');
  const more = i.participants.length > 3 ? ` +${i.participants.length - 3}` : '';
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="mt-1 shrink-0">
        <ChannelBadge channel={i.channel} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm font-medium text-zinc-900">{i.title}</p>
          <span className="shrink-0 text-xs text-zinc-500">
            {fmtRelative(i.occurredAt)}
          </span>
        </div>
        <p className="truncate text-xs text-zinc-500">
          {names}
          {more}
        </p>
      </div>
    </li>
  );
}
