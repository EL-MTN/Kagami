import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { loginAction } from '@/lib/auth-actions';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const c = await cookies();
  if (verifySessionToken(c.get(SESSION_COOKIE)?.value)) {
    redirect('/');
  }
  const sp = await searchParams;
  const error = sp.error === '1';

  return (
    <div className="mx-auto mt-24 max-w-sm px-6">
      <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight text-zinc-900">
        Kizuna
      </h1>
      <form
        action={loginAction}
        className="space-y-3 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm"
      >
        <label
          htmlFor="key"
          className="block text-xs font-medium uppercase tracking-wide text-zinc-500"
        >
          API key
        </label>
        <input
          id="key"
          name="key"
          type="password"
          autoComplete="off"
          required
          autoFocus
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-300"
        />
        {error ? (
          <p className="text-xs text-rose-700">Invalid API key.</p>
        ) : null}
        <button
          type="submit"
          className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Sign in
        </button>
        <p className="pt-1 text-center text-xs text-zinc-500">
          Same key as <code className="font-mono">KIZUNA_API_KEY</code>.
        </p>
      </form>
    </div>
  );
}
