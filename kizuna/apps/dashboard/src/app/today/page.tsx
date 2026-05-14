import { api } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import type { DigestFollowup, Interaction, Person } from "@/lib/types";
import {
  Card,
  CardHeader,
  ChannelBadge,
  DirectionBadge,
  Empty,
  ErrorBlock,
  PageHeader,
  PersonLink,
} from "../ui";

export const dynamic = "force-dynamic";

const TZ = "America/New_York";

// Returns the UTC ms at which the wall-clock parts of `date` in TZ would land
// if interpreted as if they were UTC. The difference (this minus date.getTime())
// is the TZ offset at that exact instant.
function tzWallAsUtcMs(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
}

// Returns the UTC instant of 00:00 on (year, month, day) in TZ. month is 1-12.
// Computes the offset at the midnight probe itself (not "now"), so DST
// transition days don't shift the result by an hour. Day overflow is fine:
// Date.UTC(2026, 11, 32) normalizes to 2027-01-01.
function startOfDayInTZ(year: number, month: number, day: number): Date {
  const probeMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMs = tzWallAsUtcMs(new Date(probeMs)) - probeMs;
  return new Date(probeMs - offsetMs);
}

async function fetchData() {
  const now = new Date();
  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(todayParts.find((p) => p.type === t)?.value ?? "0");
  const Y = get("year");
  const M = get("month");
  const D = get("day");

  const start = startOfDayInTZ(Y, M, D);
  // Tomorrow's midnight in TZ — avoids the `start + 24h` bug on DST transition
  // days, where the local day is 23 or 25 hours long.
  const endOfDay = startOfDayInTZ(Y, M, D + 1);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [digest, calendarToday, recent] = await Promise.all([
    api.getDigest("PT24H"),
    api.listInteractions({
      channel: "calendar",
      occurredAfter: start.toISOString(),
      occurredBefore: endOfDay.toISOString(),
      sort: "occurredAt:-1",
      limit: 50,
    }),
    api.listInteractions({
      occurredAfter: since24h.toISOString(),
      sort: "occurredAt:-1",
      limit: 25,
    }),
  ]);

  const participantIds = new Set<string>();
  for (const i of [...calendarToday.items, ...recent.items]) {
    for (const p of i.participants) participantIds.add(p.personId);
  }
  const people = await Promise.all(
    [...participantIds].map((id) => api.getPerson(id).catch(() => null)),
  );
  const personById = new Map<string, Person>();
  for (const p of people) if (p) personById.set(p.id, p);

  return { digest, calendarToday, recent, personById };
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

  const { digest, calendarToday, recent, personById } = data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Today"
        description={`${digest.overdue.length} overdue · ${digest.upcoming.length} due soon · ${calendarToday.items.length} on the calendar · ${recent.items.length} interactions in 24h`}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>Overdue followups</CardHeader>
          {digest.overdue.length === 0 ? (
            <div className="p-4">
              <Empty>Nothing overdue.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {digest.overdue.map((f) => (
                <FollowupRow key={f.id} f={f} />
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>Due in the next 24h</CardHeader>
          {digest.upcoming.length === 0 ? (
            <div className="p-4">
              <Empty>Nothing due soon.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {digest.upcoming.map((f) => (
                <FollowupRow key={f.id} f={f} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className="space-y-3">
        <h3 className="kicker">Today on the calendar</h3>
        <Card>
          {calendarToday.items.length === 0 ? (
            <div className="p-4">
              <Empty>No calendar events today.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {calendarToday.items.map((i) => (
                <InteractionRow key={i.id} i={i} personById={personById} />
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className="space-y-3">
        <h3 className="kicker">Last 24 hours</h3>
        <Card>
          {recent.items.length === 0 ? (
            <div className="p-4">
              <Empty>No interactions in the last 24 hours.</Empty>
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

function FollowupRow({ f }: { f: DigestFollowup }) {
  return (
    <li className="flex items-start justify-between gap-3 px-5 py-3 transition-colors hover:bg-accent/50">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <DirectionBadge direction={f.direction} />
          {f.person ? (
            <PersonLink id={f.person.id} name={f.person.displayName} />
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
