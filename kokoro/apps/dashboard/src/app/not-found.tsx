import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
      <p className="font-display text-6xl text-primary/15 select-none">404</p>
      <p className="text-sm text-muted-foreground">Page not found</p>
      <Link
        href="/"
        className="mt-2 rounded-lg bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
      >
        Back to overview
      </Link>
    </div>
  );
}
