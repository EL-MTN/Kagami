import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { loginAction } from "@/lib/auth-actions";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const c = await cookies();
  if (verifySessionToken(c.get(SESSION_COOKIE)?.value)) {
    redirect("/");
  }
  const sp = await searchParams;
  const error = sp.error === "1";

  return (
    <div className="relative mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-12">
      <div className="mb-8 flex flex-col items-center gap-3">
        <span className="font-display text-6xl leading-none text-foreground select-none">絆</span>
        <div className="text-center">
          <h1 className="font-display text-3xl leading-none text-foreground">Kizuna</h1>
          <p className="mt-2 text-[10px] uppercase tracking-[0.22em] text-faint">
            Personal CRM · Read-only
          </p>
        </div>
      </div>

      <form
        action={loginAction}
        className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
      >
        <div>
          <label htmlFor="key" className="kicker block">
            API key
          </label>
          <input
            id="key"
            name="key"
            type="password"
            autoComplete="off"
            required
            autoFocus
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-xs transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40"
          />
        </div>
        {error ? <p className="text-xs text-critical">Invalid API key.</p> : null}
        <Button type="submit" className="w-full">
          Sign in
        </Button>
        <p className="pt-1 text-center text-[11px] text-faint">
          Same key as <code className="font-mono text-muted-foreground">KIZUNA_API_KEY</code>.
        </p>
      </form>
    </div>
  );
}
