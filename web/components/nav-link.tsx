'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Sun,
  Users,
  Network,
  RefreshCw,
  AlertTriangle,
  Skull,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const iconMap = {
  Sun,
  Users,
  Network,
  RefreshCw,
  AlertTriangle,
  Skull,
} as const;

export type IconName = keyof typeof iconMap;

interface NavLinkProps {
  href: string;
  label: string;
  iconName: IconName;
}

export function NavLink({ href, label, iconName }: NavLinkProps) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  const Icon = iconMap[iconName];

  return (
    <Link
      href={href}
      className={cn(
        'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary" />
      )}
      <Icon
        className={cn(
          'h-4 w-4 transition-colors',
          active ? 'text-primary' : 'text-faint group-hover:text-muted-foreground',
        )}
        strokeWidth={1.75}
      />
      <span className="flex-1 font-medium">{label}</span>
    </Link>
  );
}
