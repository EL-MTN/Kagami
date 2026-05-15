import { PageHeader } from "@/components/shell";
import { KANSOKU_BASE } from "@/lib/api";
import { TailClient } from "./tail-client";

export const dynamic = "force-dynamic";

export default function TailPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Live tail"
        description="Real-time stream from every shipper. Filter by service or level; pause to inspect."
      />
      <TailClient apiBase={KANSOKU_BASE} />
    </div>
  );
}
