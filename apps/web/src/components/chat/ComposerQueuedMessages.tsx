import {
  ArrowRightIcon,
  ImageIcon,
  LockIcon,
  PencilIcon,
  TerminalSquareIcon,
  Trash2Icon,
} from "lucide-react";
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
        "mb-2 overflow-hidden rounded-lg border border-border/50 bg-background/80 shadow-[0_18px_42px_-32px_rgba(0,0,0,0.82)] supports-[backdrop-filter]:bg-background/75 supports-[backdrop-filter]:backdrop-blur-md",
        props.className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/35 bg-muted/[0.08] px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/70"
          >
            <span className="grid grid-cols-3 gap-0.5">
              <span className="size-1 rounded-full bg-primary/80" />
              <span className="size-1 rounded-full bg-primary/55" />
              <span className="size-1 rounded-full bg-primary/35" />
            </span>
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground/70 uppercase">
              Queue
            </span>
            <span className="rounded-full border border-border/45 bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/72">
              Pending
            </span>
          </div>
          <span className="rounded-full border border-border/45 bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/70">
            {props.messages.length}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 rounded-md border border-transparent px-2 text-[10px] font-medium text-muted-foreground/65 hover:border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
          onClick={props.onClearAll}
          aria-label="Clear queued messages"
          title="Clear queue"
        >
          Clear all
        </Button>
      </header>

      <div className="max-h-56 overflow-y-auto px-2 py-2 sm:px-3">
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
                "group relative mb-1.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border border-transparent px-2 py-2.5 transition-all last:mb-0",
                isSteered
                  ? "border-primary/22 bg-primary/[0.075] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
                  : "bg-muted/[0.045] hover:border-border/45 hover:bg-muted/[0.08]",
              )}
            >
              <div
                aria-hidden="true"
                className="absolute top-2.5 bottom-2.5 left-0 w-px rounded-full bg-border/35"
              />

              <div className="flex w-8 shrink-0 flex-col items-center gap-1 pt-0.5">
                <span
                  className={cn(
                    "inline-flex h-6 min-w-6 items-center justify-center rounded-md border px-1 font-mono text-[10px] font-semibold tabular-nums",
                    isSteered
                      ? "border-primary/25 bg-primary/12 text-primary"
                      : "border-border/45 bg-background/72 text-muted-foreground/62",
                  )}
                >
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "h-full w-px min-h-4 rounded-full",
                    index === props.messages.length - 1
                      ? "bg-transparent"
                      : isSteered
                        ? "bg-primary/22"
                        : "bg-border/35",
                  )}
                />
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/60">
                  <span className="font-medium text-muted-foreground/78">
                    {PROVIDER_DISPLAY_NAMES[message.modelSelection.provider]}
                  </span>
                  <span className="text-muted-foreground/35" aria-hidden="true">
                    ⋅
                  </span>
                  <span className="truncate font-mono">{message.modelSelection.model}</span>
                  {isDesignerComment ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-primary/80 uppercase">
                      <LockIcon className="size-3" />
                      Comment
                    </span>
                  ) : null}
                  {isSteered ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/22 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] text-primary/85 uppercase">
                      <ArrowRightIcon className="size-3" />
                      Steering
                    </span>
                  ) : null}
                </div>

                <div className="mt-1.5 text-[12px] leading-5 text-foreground/88 break-words">
                  {preview}
                </div>

                {(message.images.length > 0 || message.terminalContexts.length > 0) && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/60">
                    {message.images.length > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/35 bg-background/60 px-1.5 py-0.5">
                        <ImageIcon className="size-3" />
                        {message.images.length} image
                        {message.images.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                    {message.terminalContexts.length > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/35 bg-background/60 px-1.5 py-0.5">
                        <TerminalSquareIcon className="size-3" />
                        {message.terminalContexts.length} terminal
                        {message.terminalContexts.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1 rounded-md border border-border/35 bg-background/72 p-0.5 opacity-100 transition-all duration-150 sm:translate-x-1 sm:opacity-0 sm:group-hover:translate-x-0 sm:group-hover:opacity-100 sm:group-focus-within:translate-x-0 sm:group-focus-within:opacity-100">
                {showSteerButton ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className={cn(
                      "size-6 rounded-sm transition-all",
                      isSteered
                        ? "bg-primary/10 text-primary hover:bg-primary/16"
                        : "text-muted-foreground/65 hover:bg-muted/35 hover:text-primary",
                    )}
                    onClick={() => props.onSteer(message.id)}
                    aria-label={isSteered ? "Steering queued message" : "Steer queued message"}
                    title={isSteered ? "Steering queued message" : "Steer queued message"}
                  >
                    <ArrowRightIcon className="size-3.5" />
                  </Button>
                ) : null}
                {!isDesignerComment ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-sm text-muted-foreground/65 transition-all hover:bg-muted/35 hover:text-foreground"
                    onClick={() => props.onEdit(message.id)}
                    aria-label="Edit queued message"
                    title="Edit queued message"
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 rounded-sm text-muted-foreground/65 transition-all hover:bg-destructive/10 hover:text-destructive"
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
