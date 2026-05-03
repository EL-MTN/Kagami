import Link from 'next/link';

const links = [
  { href: '/', label: 'Today' },
  { href: '/people', label: 'People' },
  { href: '/contexts', label: 'Contexts' },
  { href: '/sync', label: 'Sync' },
  { href: '/errors', label: 'Errors' },
  { href: '/tombstones', label: 'Tombstones' },
];

export function Nav() {
  return (
    <nav className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
        <Link
          href="/"
          className="font-semibold tracking-tight text-zinc-900"
        >
          Kizuna
        </Link>
        <ul className="flex gap-5 text-sm text-zinc-600">
          {links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="transition-colors hover:text-zinc-900"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto text-xs text-zinc-400">read-only</div>
      </div>
    </nav>
  );
}
