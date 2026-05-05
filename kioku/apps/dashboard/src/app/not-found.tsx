import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-4">
      <p className="text-[10px] uppercase tracking-[0.2em] text-faint">404</p>
      <h2 className="font-display text-3xl text-foreground">Not in memory.</h2>
      <p className="text-sm text-muted-foreground">
        The page or fact you asked for doesn&apos;t exist.
      </p>
      <Link
        href="/"
        className="inline-flex text-sm text-primary underline-offset-4 hover:underline"
      >
        Back to overview
      </Link>
    </div>
  );
}
