import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import {
  Badge,
  Card,
  Empty,
  ErrorBlock,
  Mono,
  PageHeader,
  PersonLink,
} from '../ui';
import type { ListPeopleQuery } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Search = {
  q?: string;
  source?: string;
  tag?: string | string[];
  cursor?: string;
  includeTombstoned?: string;
};

const PAGE_SIZE = 50;

function buildQuery(sp: Search): ListPeopleQuery {
  const tag = sp.tag
    ? Array.isArray(sp.tag)
      ? sp.tag
      : [sp.tag]
    : undefined;
  const out: ListPeopleQuery = {
    limit: PAGE_SIZE,
    sort: 'lastInteractionAt:-1',
  };
  if (sp.q) out.query = sp.q;
  if (sp.source) out.source = sp.source;
  if (tag) out.tag = tag;
  if (sp.cursor) out.cursor = sp.cursor;
  if (sp.includeTombstoned === 'true') out.includeTombstoned = true;
  return out;
}

function buildHref(
  sp: Search,
  overrides: Omit<Partial<Search>, 'cursor'> & { cursor?: string | null },
): string {
  const params = new URLSearchParams();
  const merged: Search = { ...sp };
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'cursor' && v === null) {
      delete merged.cursor;
    } else if (v !== undefined) {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) params.append(k, x);
    else params.set(k, String(v));
  }
  const s = params.toString();
  return `/people${s ? `?${s}` : ''}`;
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const query = buildQuery(sp);

  let result;
  try {
    result = await api.listPeople(query);
  } catch (err) {
    return (
      <>
        <PageHeader title="People" />
        <ErrorBlock
          title="Couldn't load people"
          detail={err instanceof Error ? err.message : String(err)}
        />
      </>
    );
  }

  const tags = sp.tag
    ? Array.isArray(sp.tag)
      ? sp.tag
      : [sp.tag]
    : [];

  return (
    <>
      <PageHeader
        title="People"
        subtitle="Sorted by most recent interaction. Filter via the querystring."
      />

      <form
        className="mb-4 flex flex-wrap gap-2"
        action="/people"
        method="get"
      >
        <input
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="search name / notes / tags"
          className="w-64 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300"
        />
        <select
          name="source"
          defaultValue={sp.source ?? ''}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="">any source</option>
          <option value="concierge">concierge</option>
          <option value="gmail-sync">gmail-sync</option>
          <option value="gcal-sync">gcal-sync</option>
          <option value="manual">manual</option>
          <option value="import">import</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-zinc-600">
          <input
            type="checkbox"
            name="includeTombstoned"
            value="true"
            defaultChecked={sp.includeTombstoned === 'true'}
          />
          include tombstoned
        </label>
        <button
          type="submit"
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
        >
          Apply
        </button>
        {(sp.q || sp.source || sp.includeTombstoned || tags.length > 0) && (
          <Link
            href="/people"
            className="self-center text-xs text-zinc-500 hover:text-zinc-700"
          >
            clear
          </Link>
        )}
      </form>

      {tags.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-500">filter tags:</span>
          {tags.map((t) => (
            <Link
              key={t}
              href={buildHref(sp, { tag: tags.filter((x) => x !== t) })}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 hover:bg-zinc-200"
            >
              {t} <span className="text-zinc-400">×</span>
            </Link>
          ))}
        </div>
      )}

      <Card>
        {result.items.length === 0 ? (
          <div className="p-6">
            <Empty>No people match these filters.</Empty>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Tags</th>
                <th className="px-4 py-2 font-medium">Last interaction</th>
                <th className="px-4 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {result.items.map((p) => (
                <tr
                  key={p.id}
                  className={p.deletedAt ? 'opacity-50' : undefined}
                >
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <PersonLink id={p.id} name={p.displayName} />
                      {p.deletedAt ? <Badge tone="red">tombstoned</Badge> : null}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-zinc-600">
                    {p.primaryEmail ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {p.tags.length === 0
                        ? '—'
                        : p.tags.map((t) => (
                            <Link
                              key={t}
                              href={buildHref(sp, {
                                tag: [...new Set([...tags, t])],
                                cursor: null,
                              })}
                              className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-200"
                            >
                              {t}
                            </Link>
                          ))}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-zinc-600">
                    {fmtRelative(p.lastInteractionAt)}
                  </td>
                  <td className="px-4 py-2">
                    <Mono>{p.source}</Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="mt-4 flex items-center justify-between text-sm text-zinc-600">
        <span>{result.items.length} shown</span>
        {result.nextCursor ? (
          <Link
            href={buildHref(sp, { cursor: result.nextCursor })}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 hover:bg-zinc-50"
          >
            Next page →
          </Link>
        ) : (
          <span className="text-zinc-400">end of results</span>
        )}
      </div>
    </>
  );
}
