import { NavLink } from "./nav-link";
import type { IconName } from "./nav-link";

const links: { href: string; label: string; iconName: IconName }[] = [
  { href: "/", label: "Overview", iconName: "LayoutDashboard" },
  { href: "/conversations", label: "Conversations", iconName: "MessageSquare" },
  { href: "/memories", label: "Memories", iconName: "Brain" },
  { href: "/reminders", label: "Reminders", iconName: "Bell" },
  { href: "/skills", label: "Skills", iconName: "Zap" },
  { href: "/usage", label: "Usage", iconName: "Coins" },
];

export function Sidebar() {
  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center border-b border-border px-4">
        <h1 className="text-lg font-semibold text-primary">Mashiro</h1>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {links.map((link) => (
          <NavLink key={link.href} href={link.href} label={link.label} iconName={link.iconName} />
        ))}
      </nav>
    </aside>
  );
}
