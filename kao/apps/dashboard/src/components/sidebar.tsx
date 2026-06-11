import { Suspense } from "react";
import { NavLink, type IconName } from "./nav-link";
import { getHealth } from "@/lib/api";

const links: { href: string; label: string; iconName: IconName }[] = [
  { href: "/", label: "Grants", iconName: "KeyRound" },
];

// Sidebar chrome is sync so RootLayout (and every page it wraps) renders
// immediately. The health probe is moved into a Suspense'd async child so a
// hung/slow Kao only delays the badge, not the entire navigation.
export function Sidebar() {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-16 items-center gap-3 px-6">
        <span className="font-display text-3xl leading-none text-foreground select-none">顔</span>
        <div>
          <h1 className="font-display text-xl leading-none tracking-wide text-foreground">Kao</h1>
          <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-faint">Identity</p>
        </div>
      </div>

      <div className="mx-5 h-px bg-border" />

      <nav className="flex flex-1 flex-col gap-0.5 p-4">
        {links.map((link) => (
          <NavLink key={link.href} href={link.href} label={link.label} iconName={link.iconName} />
        ))}
      </nav>

      <Suspense fallback={<HealthBadge state="probing" />}>
        <ApiHealthBadge />
      </Suspense>
    </aside>
  );
}

async function ApiHealthBadge() {
  // Sidebar must render even if the API is unreachable, otherwise the
  // operator can't navigate to fix the problem. The Suspense boundary above
  // lets the rest of the layout stream while we wait on /health.
  const ok = await getHealth().then(
    () => true,
    () => false,
  );
  return <HealthBadge state={ok ? "ok" : "unreachable"} />;
}

function HealthBadge({ state }: { state: "ok" | "unreachable" | "probing" }) {
  const dotColor =
    state === "ok"
      ? "bg-[color:var(--color-positive)]"
      : state === "probing"
        ? "bg-muted"
        : "bg-[color:var(--color-critical)]";
  const label = state === "probing" ? "probing…" : state;
  return (
    <div className="flex items-center gap-2 px-6 pb-5 text-[11px] tabular-nums text-faint">
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden />
      <span>api {label}</span>
    </div>
  );
}
