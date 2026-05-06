import { api } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import type { Followup, Interaction, Person } from "@/lib/types";
import {
  Card,
  CardHeader,
  ChannelBadge,
  DirectionBadge,
  Empty,
  ErrorBlock,
  PageHeader,
  PersonLink,
} from "./ui";

export const dynamic = "force-dynamic";

async function fetchData() {
  const now = new Date().toISOString();
  const [overdue, upcoming, recent] = await Promise.all([
    api.listFollowups({ status: "open", dueBefore: now, limit: 25 }),
    api.listFollowups({ status: "open", dueAfter: now, limit: 25 }),
    api.listInteractions({ limit: 15 }),
  ]);
  const personIds = new Set<string>();
  for (const f of [...overdue.items, ...upcoming.items]) personIds.add(f.personId);
  for (const i of recent.items) for (const p of i.participants) personIds.add(p.personId);
  const people = await Promise.all([...personIds].map((id) => api.getPerson(id).catch(() => null)));
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
      <div className="space-y-6">
        <PageHeader title="Today" />
        <ErrorBlock
          title="Couldn't reach the API"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  const { overdue, upcoming, recent, personById } = data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Today"
        description={`${overdue.items.length} overdue · ${upcoming.items.length} upcoming · ${recent.items.length} recent`}
      />

      <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>Overdue followups</CardHeader>
          {overdue.items.length === 0 ? (
            <div className="p-4">
              <Empty>Nothing overdue.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
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
            <ul className="divide-y divide-border">
              {upcoming.items.map((f) => (
                <FollowupRow key={f.id} f={f} person={personById.get(f.personId)} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className="space-y-3">
        <h3 className="kicker">Recent interactions</h3>
        <Card>
          {recent.items.length === 0 ? (
            <div className="p-4">
              <Empty>No interactions yet. Run an ingest worker or POST one.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {recent.items.map((i) => (
                <InteractionRow key={i.id} i={i} personById={personById} />
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

function FollowupRow({ f, person }: { f: Followup; person?: Person }) {
  return (
    <li className="flex items-start justify-between gap-3 px-5 py-3 transition-colors hover:bg-accent/50">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <DirectionBadge direction={f.direction} />
          {person ? (
            <PersonLink id={person.id} name={person.displayName} />
          ) : (
            <span className="text-faint">(unknown person)</span>
          )}
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">{f.reason}</p>
      </div>
      <div className="shrink-0 text-right text-xs text-muted-foreground">
        {f.dueAt ? (
          <>
            <div className="tabular-nums">{fmtDateTime(f.dueAt)}</div>
            <div className="text-faint">{fmtRelative(f.dueAt)}</div>
          </>
        ) : (
          <span className="text-faint">no due date</span>
        )}
      </div>
    </li>
  );
}

function InteractionRow({ i, personById }: { i: Interaction; personById: Map<string, Person> }) {
  const names = i.participants
    .slice(0, 3)
    .map((p) => personById.get(p.personId)?.displayName ?? "?")
    .join(", ");
  const more = i.participants.length > 3 ? ` +${i.participants.length - 3}` : "";
  return (
    <li className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-accent/50">
      <div className="mt-1 shrink-0">
        <ChannelBadge channel={i.channel} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm font-medium text-foreground">{i.title}</p>
          <span className="shrink-0 text-xs tabular-nums text-faint">
            {fmtRelative(i.occurredAt)}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {names}
          {more}
        </p>
      </div>
    </li>
  );
}
