import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageBubble } from "@/components/message-bubble";
import { getConversationDetail } from "@/lib/queries/conversations";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const convo = await getConversationDetail(id);

  if (!convo) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          className="text-muted-foreground hover:text-foreground"
        >
          <Link href="/conversations">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h2 className="font-display text-2xl text-foreground">Conversation</h2>
          <p className="font-mono text-[10px] text-faint">{convo.sessionId}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${convo.status === "active" ? "bg-primary/70" : "bg-muted-foreground/20"}`}
            />
            {convo.status}
          </span>
          <span>
            Platform: <span className="text-foreground/60">{convo.platform}</span>
          </span>
          <span>
            Chat: <span className="font-mono text-foreground/60">{convo.chatId}</span>
          </span>
          <span>
            Messages:{" "}
            <span className="tabular-nums text-foreground/60">{convo.messages.length}</span>
          </span>
          <span>
            Created:{" "}
            <span className="tabular-nums text-foreground/60">
              {new Date(convo.createdAt).toLocaleString()}
            </span>
          </span>
          {convo.closedAt && (
            <span>
              Closed:{" "}
              <span className="tabular-nums text-foreground/60">
                {new Date(convo.closedAt).toLocaleString()}
              </span>
            </span>
          )}
        </div>
      </div>

      <ScrollArea className="h-[calc(100vh-18rem)]">
        <div className="space-y-3 pr-4">
          {convo.messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
          {convo.messages.length === 0 && (
            <p className="py-12 text-center text-sm text-faint">No messages.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
