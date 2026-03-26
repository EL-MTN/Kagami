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
    <div className={cn("flex min-w-0", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0 max-w-[75%] rounded-2xl px-4 py-3",
          isUser && "bg-primary/10 border border-primary/15",
          !isUser && !isSystem && !isTool && "bg-card border border-border",
          isSystem && "bg-muted/50 border border-border/50 text-muted-foreground text-xs italic",
          isTool && "bg-muted/30 border border-border/30 font-mono text-xs",
        )}
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              isUser ? "text-primary/60" : "text-muted-foreground/60",
            )}
          >
            {message.role}
          </span>
          <span className="text-[10px] text-muted-foreground/30">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>

        {message.imageRef && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${message.imageRef}`}
            alt="Attached"
            className="mb-2 max-h-48 rounded-lg"
          />
        )}

        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-border/30 pt-3">
            {message.toolCalls.map((tc, i) => (
              <details key={i} className="group rounded-lg bg-background/50">
                <summary className="flex cursor-pointer items-center gap-2 p-2 text-xs select-none">
                  <span className="font-semibold text-primary/70">{tc.toolName}</span>
                  <span className="text-muted-foreground/40">
                    ({Object.keys(tc.args).join(", ")})
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground/20 group-open:hidden">
                    expand
                  </span>
                </summary>
                <div className="space-y-2 border-t border-border/20 p-2 font-mono">
                  <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {JSON.stringify(tc.args, null, 2)}
                  </pre>
                  {tc.result && (
                    <>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/40">
                        Result
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {tc.result}
                      </pre>
                    </>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
