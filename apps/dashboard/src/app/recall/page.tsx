import { PageHeader } from "@/components/shell";
import { RecallPlayground } from "@/components/recall-playground";

export const metadata = { title: "Recall — Kioku" };

export default function RecallPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Recall"
        description="Hybrid retrieval, no LLM. Each result decomposes into the three signals the ranker fuses: cosine similarity, BM25 lexical match, and entity boost."
      />
      <RecallPlayground />
    </div>
  );
}
