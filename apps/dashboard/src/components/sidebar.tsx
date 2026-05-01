import { NavLink } from "./nav-link";
import type { IconName } from "./nav-link";
import { getPendingConfirmationCount } from "@/lib/queries/confirmations";

const links: { href: string; label: string; iconName: IconName }[] = [
  { href: "/", label: "Overview", iconName: "LayoutDashboard" },
  { href: "/conversations", label: "Conversations", iconName: "MessageSquare" },
  { href: "/memories", label: "Memories", iconName: "Brain" },
  { href: "/confirmations", label: "Confirmations", iconName: "Hourglass" },
  { href: "/reminders", label: "Reminders", iconName: "Bell" },
  { href: "/routines", label: "Routines", iconName: "Zap" },
  { href: "/watchers", label: "Watchers", iconName: "Eye" },
  { href: "/usage", label: "Usage", iconName: "Coins" },
];

export async function Sidebar() {
  const pendingConfirmations = await getPendingConfirmationCount().catch(() => 0);

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-16 items-center gap-3 px-6">
        <span className="font-display text-3xl leading-none text-foreground select-none">白</span>
        <div>
          <h1 className="font-display text-xl leading-none tracking-wide text-foreground">
            Mashiro
          </h1>
          <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-faint">Dashboard</p>
        </div>
      </div>

      <div className="mx-5 h-px bg-border" />

      <nav className="flex flex-1 flex-col gap-0.5 p-4">
        {links.map((link) => (
          <NavLink
            key={link.href}
            href={link.href}
            label={link.label}
            iconName={link.iconName}
            badge={link.href === "/confirmations" ? pendingConfirmations : undefined}
          />
        ))}
      </nav>

      <div className="px-6 pb-5 text-[11px] tabular-nums text-faint">Mashiro v1.0</div>
    </aside>
  );
}
