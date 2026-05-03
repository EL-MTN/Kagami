import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import {
  Card,
  CardHeader,
  Empty,
  ErrorBlock,
  Mono,
  PageHeader,
  PersonLink,
} from '../ui';

export const dynamic = 'force-dynamic';

const PEEK = 200;

export default async function TombstonesPage() {
  let people, interactions, followups;
  try {
    [people, interactions, followups] = await Promise.all([
      api.listPeople({ includeTombstoned: true, limit: PEEK }),
      api.listInteractions({ includeTombstoned: true, limit: PEEK, status: 'any' }),
      api.listFollowups({ includeTombstoned: true, limit: PEEK }),
    ]);
  } catch (err) {
    return (
      <>
        <PageHeader title="Tombstones" />
        <ErrorBlock
          title="Couldn't load tombstones"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  const tombPeople = people.items.filter((p) => p.deletedAt);
  const tombInteractions = interactions.items.filter((i) => i.deletedAt);
  const tombFollowups = followups.items.filter((f) => f.deletedAt);

  return (
    <>
      <PageHeader
        title="Tombstones"
        subtitle={`Verifiable soft-deletes. (Sampling the last ${PEEK} of each — full tombstone listing is a roadmap item.)`}
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>Tombstoned people ({tombPeople.length})</CardHeader>
          {tombPeople.length === 0 ? (
            <div className="p-4">
              <Empty>None.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {tombPeople.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between px-4 py-2 text-sm"
                >
                  <PersonLink id={p.id} name={p.displayName} />
                  <span className="text-xs text-zinc-500">
                    {p.suppressReingest ? 'suppressReingest=true · ' : ''}
                    {fmtDateTime(p.deletedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            Tombstoned interactions ({tombInteractions.length})
          </CardHeader>
          {tombInteractions.length === 0 ? (
            <div className="p-4">
              <Empty>None.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {tombInteractions.map((i) => (
                <li
                  key={i.id}
                  className="flex items-center justify-between px-4 py-2 text-sm"
                >
                  <span className="truncate text-zinc-800">{i.title}</span>
                  <span className="text-xs text-zinc-500">
                    <Mono>{i.channel}</Mono> · {fmtDateTime(i.deletedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            Tombstoned followups ({tombFollowups.length})
          </CardHeader>
          {tombFollowups.length === 0 ? (
            <div className="p-4">
              <Empty>None.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {tombFollowups.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between px-4 py-2 text-sm"
                >
                  <span className="truncate text-zinc-700">{f.reason}</span>
                  <span className="text-xs text-zinc-500">
                    {fmtDateTime(f.deletedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
