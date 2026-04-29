import { IconTerminal } from "@tabler/icons-react";
import { ImageIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type MessageId, type ModelSelection } from "@ace/contracts";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ComposerQueuedMessageItem {
  id: MessageId;
  prompt: string;
  images: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<{ id: string }>;
  modelSelection: ModelSelection;
}

export function ComposerQueuedMessages(props: {
  messages: ReadonlyArray<ComposerQueuedMessageItem>;
  className?: string;
  steerMessageId?: MessageId | null;
  onEdit: (messageId: MessageId) => void;
  onDelete: (messageId: MessageId) => void;
  onClearAll: () => void;
  onSteer: (messageId: MessageId) => void;
}) {
  const hasMessages = props.messages.length > 0;
  if (!hasMessages) {
    return null;
  }

  return (
    <section
      className={cn(
        "mb-3 overflow-hidden rounded-[14px] border border-border/60 bg-card/70",
        props.className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/70 uppercase">
            Queue
          </span>
          <span className="rounded-full border border-border/55 bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/75">
            {props.messages.length}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 rounded-md border border-transparent px-2 text-[10px] font-medium text-muted-foreground/65 hover:border-destructive/20 hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-45"
          onClick={props.onClearAll}
          disabled={!hasMessages}
          aria-label="Clear queued messages"
          title="Clear queue"
        >
          Clear all
        </Button>
      </div>
      <div className="max-h-[126px] overflow-y-auto">
        {props.messages.map((message, index) => {
          const textPreview = message.prompt.replace(/\s+/g, " ").trim();
          const preview = textPreview.length > 0 ? textPreview : "Queue Message";
          const isSteered = props.steerMessageId === message.id;
          return (
            <div
              key={message.id}
              className="grid min-h-[42px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-3 py-1.5 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="shrink-0 font-mono text-[12px] font-semibold text-foreground/72">
                  {index + 1}.
                </span>
                <p className="truncate text-[13px] font-medium text-foreground/90">{preview}</p>
                {message.images.length > 0 ? (
                  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border/55 bg-background/80 text-muted-foreground/70">
                    <ImageIcon className="size-3" />
                  </span>
                ) : null}
                {message.terminalContexts.length > 0 ? (
                  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border/55 bg-background/80 text-muted-foreground/70">
                    <IconTerminal className="size-3" />
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={isSteered ? "default" : "outline"}
                  className="h-7 rounded-md px-2.5 text-[12px] font-medium"
                  onClick={() => {
                    props.onSteer(message.id);
                  }}
                  aria-label={isSteered ? "Steering queued message" : "Steer queued message"}
                >
                  {isSteered ? "Steering" : "Steer"}
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-7 rounded-md text-muted-foreground/70 hover:bg-muted/35 hover:text-foreground"
                  onClick={() => {
                    props.onEdit(message.id);
                  }}
                  aria-label="Edit queued message"
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-7 rounded-md text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    props.onDelete(message.id);
                  }}
                  aria-label="Delete queued message"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
