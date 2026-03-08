import type { IMessage } from "@mashiro/db";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  message: IMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-4 py-2",
          isUser && "bg-primary text-primary-foreground",
          !isUser && !isSystem && !isTool && "bg-card border border-border",
          isSystem && "bg-muted text-muted-foreground text-xs italic",
          isTool && "bg-muted/50 border border-border/50 text-xs font-mono",
        )}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium opacity-70">
            {message.role}
          </span>
          <span className="text-xs opacity-50">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>

        {message.imageRef && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${message.imageRef}`}
            alt="Attached"
            className="mb-2 max-h-48 rounded"
          />
        )}

        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
            {message.toolCalls.map((tc, i) => (
              <div key={i} className="rounded bg-muted/50 p-2 text-xs font-mono">
                <span className="font-semibold text-primary">{tc.toolName}</span>
                <span className="ml-1 text-muted-foreground">
                  ({Object.keys(tc.args).join(", ")})
                </span>
                {tc.result && (
                  <p className="mt-1 truncate text-muted-foreground">{tc.result}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
