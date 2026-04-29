import { getWatcherList } from "@/lib/queries/watchers";
import { WatcherTable } from "@/components/watchers/watcher-table";

export default async function WatchersPage() {
  const watchers = await getWatcherList();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-3xl text-foreground">Watchers</h2>
        <p className="mt-1 text-sm text-muted-foreground/70">
          Scheduled detection jobs — observe, compare, notify on change
        </p>
      </div>
      <WatcherTable initialWatchers={watchers} />
    </div>
  );
}
