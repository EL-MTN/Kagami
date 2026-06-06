import type { Metadata } from "next";
import { Instrument_Serif, DM_Sans, JetBrains_Mono } from "next/font/google";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

const instrumentSerif = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Kagami Cockpit",
  description: "Workspace operator cockpit for Kagami.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}
    >
      <body className="flex min-h-screen">
        <Sidebar />
        <main className="relative flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl px-6 py-7 lg:px-8">{children}</div>
        </main>
      </body>
    </html>
  );
}
