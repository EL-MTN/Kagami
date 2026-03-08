import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link href="/conversations">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h2 className="text-2xl font-bold">Conversation</h2>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="font-mono text-sm">{convo.sessionId}</CardTitle>
            <Badge variant={convo.status === "active" ? "default" : "secondary"}>
              {convo.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>Platform: {convo.platform}</span>
            <span>Chat: {convo.chatId}</span>
            <span>Messages: {convo.messages.length}</span>
            <span>Created: {new Date(convo.createdAt).toLocaleString()}</span>
            {convo.closedAt && <span>Closed: {new Date(convo.closedAt).toLocaleString()}</span>}
          </div>
        </CardContent>
      </Card>

      <ScrollArea className="h-[calc(100vh-20rem)]">
        <div className="space-y-3 pr-4">
          {convo.messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
          {convo.messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">No messages.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
