import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    redirect("/login");
  }
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="relative flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
