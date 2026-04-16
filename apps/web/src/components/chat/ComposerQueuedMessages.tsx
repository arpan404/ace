import { BotIcon, ImageIcon, PencilLineIcon, TerminalSquareIcon, Trash2Icon } from "lucide-react";
import { PROVIDER_DISPLAY_NAMES, type MessageId, type ModelSelection } from "@ace/contracts";

import { formatQueuedComposerMessagePreview } from "../../lib/chat/chatView";
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
    <div
      className={cn(
        "mb-3 overflow-hidden rounded-t-[19px] border border-border/50 bg-card/40 shadow-sm backdrop-blur-sm",
        props.className,
      )}
    >
      <div className="px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/50" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary/70" />
            </span>
            <span className="text-[10px] font-semibold tracking-[0.2em] text-muted-foreground/45 uppercase">
              Queued
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {props.messages.length > 1 ? (
              <span className="flex h-[18px] items-center rounded-full bg-primary/8 px-2 text-[10px] font-semibold tabular-nums text-primary/70">
                {props.messages.length}
              </span>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 rounded-md px-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/60 uppercase hover:bg-destructive/10 hover:text-destructive"
              onClick={props.onClearAll}
              aria-label="Clear queued messages"
              title="Clear queue"
            >
              Clear
            </Button>
          </div>
        </div>

        <div className="mt-2.5 max-h-44 space-y-1.5 overflow-y-auto pr-1">
          {props.messages.map((message, index) => {
            const preview = formatQueuedComposerMessagePreview({
              prompt: message.prompt,
              imageCount: message.images.length,
              terminalContextCount: message.terminalContexts.length,
            });
            const isSteered = props.steerMessageId === message.id;
            const showSteerButton = props.steerMessageId === null || isSteered;

            return (
              <div
                key={message.id}
                className={cn(
                  "group relative rounded-xl border px-3 py-2.5 transition-all duration-200",
                  isSteered
                    ? "border-primary/30 bg-primary/6 shadow-[0_0_12px_-4px] shadow-primary/15"
                    : "border-border/30 bg-muted/15 hover:border-border/50 hover:bg-muted/30",
                )}
              >
                <div className="flex items-start gap-3">
                  <kbd
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums transition-all duration-200",
                      isSteered
                        ? "bg-primary/15 text-primary shadow-sm shadow-primary/10"
                        : "bg-muted/30 text-muted-foreground/40 group-hover:bg-muted/50 group-hover:text-muted-foreground/60",
                    )}
                  >
                    {index + 1}
                  </kbd>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/60">
                      <span className="font-medium">
                        {PROVIDER_DISPLAY_NAMES[message.modelSelection.provider]}
                      </span>
                      <span className="text-muted-foreground/30" aria-hidden="true">
                        ⋅
                      </span>
                      <span className="truncate font-mono text-[10px]">
                        {message.modelSelection.model}
                      </span>
                    </div>

                    <div className="mt-1.5 text-[13px] leading-snug text-foreground/85">
                      {preview}
                    </div>

                    {(message.images.length > 0 || message.terminalContexts.length > 0) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[10px] text-muted-foreground/55">
                        {message.images.length > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted/25 px-1.5 py-0.5">
                            <ImageIcon className="size-3" />
                            {message.images.length}
                          </span>
                        ) : null}
                        {message.terminalContexts.length > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted/25 px-1.5 py-0.5">
                            <TerminalSquareIcon className="size-3" />
                            {message.terminalContexts.length}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-2.5 flex items-center gap-0.5 pl-8 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                  {showSteerButton ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className={cn(
                        "size-6 rounded-lg transition-all duration-200",
                        isSteered
                          ? "bg-primary/12 text-primary hover:bg-primary/18"
                          : "text-muted-foreground/60 hover:bg-muted/40 hover:text-primary",
                      )}
                      onClick={() => props.onSteer(message.id)}
                      aria-label={isSteered ? "Steering queued message" : "Steer queued message"}
                      title={isSteered ? "Steering queued message" : "Steer queued message"}
                    >
                      <BotIcon className="size-3.5" />
                    </Button>
                  ) : (
                    <span className="size-6" aria-hidden="true" />
                  )}
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-lg text-muted-foreground/60 transition-all duration-200 hover:bg-muted/40 hover:text-foreground"
                    onClick={() => props.onEdit(message.id)}
                    aria-label="Edit queued message"
                    title="Edit queued message"
                  >
                    <PencilLineIcon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-lg text-muted-foreground/60 transition-all duration-200 hover:bg-destructive/10 hover:text-destructive"
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
      </div>
    </div>
  );
}
