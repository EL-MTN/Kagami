import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <header className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
        ) : null}
      </div>
      {right ? <div className="text-sm text-zinc-500">{right}</div> : null}
    </header>
  );
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-zinc-200 bg-white ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-zinc-200 px-4 py-3 text-sm font-medium text-zinc-700">
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-300 bg-white px-4 py-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'green' | 'amber' | 'red' | 'blue' | 'zinc';
}) {
  const tones: Record<string, string> = {
    default: 'bg-zinc-100 text-zinc-700',
    green: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-rose-100 text-rose-700',
    blue: 'bg-sky-100 text-sky-700',
    zinc: 'bg-zinc-200 text-zinc-700',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  const tone: 'blue' | 'amber' | 'green' | 'zinc' =
    channel === 'email'
      ? 'blue'
      : channel === 'calendar'
        ? 'amber'
        : channel === 'in_person' || channel === 'call'
          ? 'green'
          : 'zinc';
  return <Badge tone={tone}>{channel}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone: 'green' | 'red' | 'amber' | 'zinc' | 'default' =
    status === 'open'
      ? 'amber'
      : status === 'done'
        ? 'green'
        : status === 'cancelled' || status === 'dismissed'
          ? 'red'
          : status === 'snoozed'
            ? 'zinc'
            : 'default';
  return <Badge tone={tone}>{status}</Badge>;
}

export function DirectionBadge({
  direction,
}: {
  direction: 'i_owe' | 'they_owe';
}) {
  return (
    <Badge tone={direction === 'i_owe' ? 'amber' : 'blue'}>
      {direction === 'i_owe' ? 'I owe' : 'they owe'}
    </Badge>
  );
}

export function ErrorBlock({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-medium">{title}</p>
      {detail ? (
        <pre className="mt-2 whitespace-pre-wrap text-xs text-rose-700/80">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

export function PersonLink({
  id,
  name,
}: {
  id: string;
  name: string | null;
}) {
  return (
    <Link
      href={`/people/${id}`}
      className="text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-700"
    >
      {name ?? '(unnamed)'}
    </Link>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-700">
      {children}
    </code>
  );
}
