import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';
import { Nav } from './nav';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    redirect('/login');
  }
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </>
  );
}
