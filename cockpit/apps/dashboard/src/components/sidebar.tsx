import Link from "next/link";
import {
  Activity,
  Brain,
  ExternalLink,
  HeartHandshake,
  KeyRound,
  Radar,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";

const links = [
  { name: "Cockpit", href: "/", icon: Sparkles, active: true },
  { name: "Kokoro", href: "https://kokoro.localhost", icon: HeartHandshake },
  { name: "Kioku", href: "https://kioku.localhost", icon: Brain },
  { name: "Kizuna", href: "https://kizuna.localhost", icon: Activity },
  { name: "Kansoku", href: "https://kansoku.localhost", icon: Radar },
  { name: "Kao", href: "https://kao.localhost", icon: KeyRound },
];

export function Sidebar() {
  return (
    <aside className="relative hidden min-h-screen w-64 shrink-0 border-r border-border bg-card/70 px-4 py-5 backdrop-blur md:block">
      <div className="mb-8 flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-md border border-rule-strong bg-background font-display text-3xl leading-none text-primary">
          鏡
        </div>
        <div>
          <div className="font-display text-2xl leading-none">Kagami</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-faint">Cockpit</div>
        </div>
      </div>

      <nav className="space-y-1">
        {links.map((link) => {
          const Icon = link.icon;
          const external = link.href.startsWith("https://");
          return (
            <Link
              key={link.name}
              href={link.href}
              className={cn(
                "group flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
                link.active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4" />
                {link.name}
              </span>
              {external ? (
                <ExternalLink className="h-3.5 w-3.5 opacity-45 transition-opacity group-hover:opacity-80" />
              ) : null}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
