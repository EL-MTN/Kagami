"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KeyRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The sibling dashboards use a small map so the sidebar (a Server Component)
// can pass icon names as plain strings instead of crossing the boundary with
// component references. Kao only has one nav entry today, but the map keeps
// the door open for "Audit log" / "Settings" without re-plumbing types.
const iconMap = {
  KeyRound,
} as const;

export type IconName = keyof typeof iconMap;

interface NavLinkProps {
  href: string;
  label: string;
  iconName: IconName;
}

export function NavLink({ href, label, iconName }: NavLinkProps) {
  const pathname = usePathname();
  // Overview matches "/" exactly; nested pages (e.g. /grants/kokoro) keep
  // Overview highlighted as the parent because Kao only has one logical
  // section right now.
  const active =
    href === "/" ? pathname === "/" || pathname.startsWith("/grants") : pathname.startsWith(href);
  const Icon: LucideIcon = iconMap[iconName];

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
        <span className="absolute top-1/2 left-0 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary" />
      )}
      <Icon
        className={cn(
          "h-4 w-4 transition-colors",
          active ? "text-primary" : "text-faint group-hover:text-muted-foreground",
        )}
        strokeWidth={1.75}
      />
      <span className="flex-1 font-medium">{label}</span>
    </Link>
  );
}
