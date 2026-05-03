import type { Metadata } from 'next';
import './globals.css';
import { Nav } from './nav';

export const metadata: Metadata = {
  title: 'Kizuna',
  description: 'Personal CRM dashboard (read-only)',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
