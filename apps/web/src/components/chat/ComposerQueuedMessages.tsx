import { BotIcon, ImageIcon, LockIcon, TerminalSquareIcon, Trash2Icon } from "lucide-react";
import { PROVIDER_DISPLAY_NAMES, type MessageId, type ModelSelection } from "@ace/contracts";

import { formatQueuedComposerMessagePreview } from "../../lib/chat/chatView";
import { hasBrowserDesignContext } from "~/lib/terminalContext";
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
  if (props.messages.length === 0) {
    return null;
  }

  return (
    <section
      className={cn(
        "mb-3 overflow-hidden rounded-2xl border border-border/60 bg-background/92 shadow-[0_10px_40px_-28px_rgba(0,0,0,0.55)] backdrop-blur-sm",
        props.className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/50" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary/70" />
            </span>
            <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground/55 uppercase">
              Queue
            </span>
            <span className="rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[10px] font-semibold text-foreground/70">
              {props.messages.length}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground/70">
            Queued prompts are sent in order. Designer comments can be deleted but not edited.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 rounded-lg px-2.5 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/65 uppercase hover:bg-destructive/10 hover:text-destructive"
          onClick={props.onClearAll}
          aria-label="Clear queued messages"
          title="Clear queue"
        >
          Clear
        </Button>
      </header>

      <div className="max-h-56 overflow-y-auto">
        {props.messages.map((message, index) => {
          const preview = formatQueuedComposerMessagePreview({
            prompt: message.prompt,
            imageCount: message.images.length,
            terminalContextCount: message.terminalContexts.length,
          });
          const isSteered = props.steerMessageId === message.id;
          const isDesignerComment = hasBrowserDesignContext(message.prompt);
          const showSteerButton = props.steerMessageId === null || isSteered;

          return (
            <div
              key={message.id}
              className={cn(
                "group grid grid-cols-[auto_1fr_auto] items-start gap-3 border-b border-border/40 px-4 py-3 transition-colors last:border-b-0 sm:px-5",
                isSteered ? "bg-primary/7" : "hover:bg-accent/30",
              )}
            >
              <div className="mt-0.5 flex size-6 items-center justify-center rounded-full border border-border/60 bg-muted/15 text-[11px] font-semibold tabular-nums text-muted-foreground/80">
                {index + 1}
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/65">
                  <span className="font-medium">
                    {PROVIDER_DISPLAY_NAMES[message.modelSelection.provider]}
                  </span>
                  <span className="text-muted-foreground/35" aria-hidden="true">
                    ⋅
                  </span>
                  <span className="truncate font-mono">{message.modelSelection.model}</span>
                  {isDesignerComment ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[9px] font-semibold tracking-[0.14em] text-primary/80 uppercase">
                      <LockIcon className="size-3" />
                      Designer
                    </span>
                  ) : null}
                </div>

                <div className="mt-1.5 text-[13px] leading-snug text-foreground/88">{preview}</div>

                {(message.images.length > 0 ||
                  message.terminalContexts.length > 0 ||
                  isSteered) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/65">
                    {message.images.length > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted/25 px-2 py-0.5">
                        <ImageIcon className="size-3" />
                        {message.images.length}
                      </span>
                    ) : null}
                    {message.terminalContexts.length > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted/25 px-2 py-0.5">
                        <TerminalSquareIcon className="size-3" />
                        {message.terminalContexts.length}
                      </span>
                    ) : null}
                    {isSteered ? (
                      <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-primary/80">
                        Steering enabled
                      </span>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                {showSteerButton ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className={cn(
                      "size-7 rounded-lg transition-all",
                      isSteered
                        ? "bg-primary/12 text-primary hover:bg-primary/18"
                        : "text-muted-foreground/65 hover:bg-muted/40 hover:text-primary",
                    )}
                    onClick={() => props.onSteer(message.id)}
                    aria-label={isSteered ? "Steering queued message" : "Steer queued message"}
                    title={isSteered ? "Steering queued message" : "Steer queued message"}
                  >
                    <BotIcon className="size-3.5" />
                  </Button>
                ) : null}
                {!isDesignerComment ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-7 rounded-lg text-muted-foreground/65 transition-all hover:bg-muted/40 hover:text-foreground"
                    onClick={() => props.onEdit(message.id)}
                    aria-label="Edit queued message"
                    title="Edit queued message"
                  >
                    <span className="text-[10px] font-semibold uppercase">Edit</span>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-7 rounded-lg text-muted-foreground/65 transition-all hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => props.onDelete(message.id)}
                  aria-label="Delete queued message"
                  title="Delete queued message"
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
