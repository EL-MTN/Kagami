import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WatcherEditor } from "@/components/watchers/watcher-editor";
import { WatcherLogTable } from "@/components/watchers/watcher-log-table";
import { getWatcherDetail, getWatcherLogList } from "@/lib/queries/watchers";

export default async function WatcherDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [watcher, logResult] = await Promise.all([getWatcherDetail(id), getWatcherLogList(id, 50)]);

  if (!watcher) notFound();

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          className="text-muted-foreground hover:text-foreground"
        >
          <Link href="/watchers">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h2 className="font-display text-2xl text-foreground">{watcher.name}</h2>
          <p className="text-xs text-muted-foreground/50">{watcher.description}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <WatcherEditor watcher={watcher} />
      </div>

      <div>
        <h3 className="mb-4 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
          Execution History
        </h3>
        <WatcherLogTable
          watcherId={id}
          initialLogs={logResult.logs}
          initialHasMore={logResult.hasMore}
        />
      </div>
    </div>
  );
}
