import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { Card, CardHeader, Empty, ErrorBlock, Mono, PageHeader, PersonLink } from "../ui";

export const dynamic = "force-dynamic";

const PEEK = 200;

export default async function TombstonesPage() {
  let people, interactions, followups;
  try {
    [people, interactions, followups] = await Promise.all([
      api.listPeople({ includeTombstoned: true, limit: PEEK }),
      api.listInteractions({ includeTombstoned: true, limit: PEEK, status: "any" }),
      api.listFollowups({ includeTombstoned: true, limit: PEEK }),
    ]);
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title="Tombstones" />
        <ErrorBlock
          title="Couldn't load tombstones"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </div>
    );
  }

  const tombPeople = people.items.filter((p) => p.deletedAt);
  const tombInteractions = interactions.items.filter((i) => i.deletedAt);
  const tombFollowups = followups.items.filter((f) => f.deletedAt);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tombstones"
        description={`Verifiable soft-deletes. (Sampling the last ${PEEK} of each — full tombstone listing is a roadmap item.)`}
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>Tombstoned people ({tombPeople.length})</CardHeader>
          {tombPeople.length === 0 ? (
            <div className="p-4">
              <Empty>None.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {tombPeople.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                  <PersonLink id={p.id} name={p.displayName} />
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {p.suppressReingest ? "suppressReingest=true · " : ""}
                    {fmtDateTime(p.deletedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>Tombstoned interactions ({tombInteractions.length})</CardHeader>
          {tombInteractions.length === 0 ? (
            <div className="p-4">
              <Empty>None.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {tombInteractions.map((i) => (
                <li
                  key={i.id}
                  className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm"
                >
                  <span className="truncate text-foreground">{i.title}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    <Mono>{i.channel}</Mono> · {fmtDateTime(i.deletedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>Tombstoned followups ({tombFollowups.length})</CardHeader>
          {tombFollowups.length === 0 ? (
            <div className="p-4">
              <Empty>None.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {tombFollowups.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm"
                >
                  <span className="truncate text-muted-foreground">{f.reason}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {fmtDateTime(f.deletedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
