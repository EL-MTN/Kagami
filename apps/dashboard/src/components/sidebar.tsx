import { NavLink } from "./nav-link";
import type { IconName } from "./nav-link";

const links: { href: string; label: string; iconName: IconName }[] = [
  { href: "/", label: "Overview", iconName: "LayoutDashboard" },
  { href: "/conversations", label: "Conversations", iconName: "MessageSquare" },
  { href: "/memories", label: "Memories", iconName: "Brain" },
  { href: "/reminders", label: "Reminders", iconName: "Bell" },
  { href: "/skills", label: "Skills", iconName: "Zap" },
  { href: "/watchers", label: "Watchers", iconName: "Eye" },
  { href: "/usage", label: "Usage", iconName: "Coins" },
];

export function Sidebar() {
  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-border bg-card/50">
      <div className="flex h-16 items-center gap-3 px-6">
        <span className="font-display text-2xl text-primary/30 select-none">白</span>
        <div>
          <h1 className="font-display text-lg tracking-wide text-foreground">Mashiro</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Dashboard</p>
        </div>
      </div>

      <div className="mx-5 h-px bg-gradient-to-r from-primary/20 via-primary/8 to-transparent" />

      <nav className="flex flex-1 flex-col gap-0.5 p-4">
        {links.map((link) => (
          <NavLink key={link.href} href={link.href} label={link.label} iconName={link.iconName} />
        ))}
      </nav>

      <div className="px-6 pb-5 text-[10px] tracking-widest text-muted-foreground/30 uppercase">
        Mashiro v1.0
      </div>
    </aside>
  );
}
