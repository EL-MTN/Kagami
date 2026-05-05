"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  Brain,
  Bell,
  Zap,
  Coins,
  Eye,
  Hourglass,
} from "lucide-react";
import { cn } from "@/lib/utils";

const iconMap = {
  LayoutDashboard,
  MessageSquare,
  Brain,
  Bell,
  Zap,
  Coins,
  Eye,
  Hourglass,
} as const;

export type IconName = keyof typeof iconMap;

interface NavLinkProps {
  href: string;
  label: string;
  iconName: IconName;
  badge?: number;
}

export function NavLink({ href, label, iconName, badge }: NavLinkProps) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  const Icon = iconMap[iconName];

  return (
    <Link
      href={href}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary" />
      )}
      <Icon
        className={cn(
          "h-4 w-4 transition-colors",
          active ? "text-primary" : "text-faint group-hover:text-muted-foreground",
        )}
      />
      <span className="flex-1 font-medium">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none",
            badge > 0 && active
              ? "bg-caution/15 text-caution"
              : "bg-caution/10 text-caution group-hover:bg-caution/15",
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}
