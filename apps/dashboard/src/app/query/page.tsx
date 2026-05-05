import { PageHeader } from "@/components/shell";
import { QueryPlayground } from "@/components/query-playground";

export const metadata = { title: "Query — Kioku" };

export default function QueryPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Query"
        description="Top-K hybrid retrieval into the answerer prompt. Cited facts with score breakdowns appear below the answer."
      />
      <QueryPlayground />
    </div>
  );
}
