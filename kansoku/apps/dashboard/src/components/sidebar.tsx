import { NavLink, type IconName } from "./nav-link";
import { getVersion } from "@/lib/api";

const links: { href: string; label: string; iconName: IconName }[] = [
  { href: "/", label: "Overview", iconName: "Activity" },
  { href: "/tail", label: "Live tail", iconName: "Radio" },
  { href: "/search", label: "Search", iconName: "Search" },
  { href: "/traces", label: "Traces", iconName: "Waypoints" },
  { href: "/errors", label: "Errors", iconName: "AlertTriangle" },
  { href: "/services", label: "Services", iconName: "Layers" },
];

export async function Sidebar() {
  const version = await getVersion().catch(() => ({ version: "—" }));

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-16 items-center gap-3 px-6">
        <span className="font-display text-3xl leading-none text-foreground select-none">観</span>
        <div>
          <h1 className="font-display text-xl leading-none tracking-wide text-foreground">
            Kansoku
          </h1>
          <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-faint">Observation</p>
        </div>
      </div>

      <div className="mx-5 h-px bg-border" />

      <nav className="flex flex-1 flex-col gap-0.5 p-4">
        {links.map((link) => (
          <NavLink key={link.href} href={link.href} label={link.label} iconName={link.iconName} />
        ))}
      </nav>

      <div className="px-6 pb-5 text-[11px] tabular-nums text-faint">
        kansoku v{version.version}
      </div>
    </aside>
  );
}
