import { IconTerminal } from "@tabler/icons-react";
import { GripVerticalIcon, ImageIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type MessageId, type ModelSelection } from "@ace/contracts";
import { useEffect, useMemo, useState, type DragEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

type QueueReorderPlacement = "before" | "after";

function moveMessageId(
  messageIds: ReadonlyArray<MessageId>,
  draggedMessageId: MessageId,
  targetMessageId: MessageId,
  placement: QueueReorderPlacement,
): ReadonlyArray<MessageId> {
  const draggedIndex = messageIds.indexOf(draggedMessageId);
  const targetIndex = messageIds.indexOf(targetMessageId);
  if (draggedIndex < 0 || targetIndex < 0 || messageIds.length <= 1) {
    return messageIds;
  }
  const nextIds = [...messageIds];
  const [dragged] = nextIds.splice(draggedIndex, 1);
  if (!dragged) {
    return messageIds;
  }
  let insertionIndex = targetIndex;
  if (draggedIndex < targetIndex) {
    insertionIndex -= 1;
  }
  if (placement === "after") {
    insertionIndex += 1;
  }
  insertionIndex = Math.max(0, Math.min(nextIds.length, insertionIndex));
  nextIds.splice(insertionIndex, 0, dragged);
  return nextIds;
}

function resolveDropPlacement(event: DragEvent<HTMLDivElement>): QueueReorderPlacement {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

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
  onReorder: (
    draggedMessageId: MessageId,
    targetMessageId: MessageId,
    placement: QueueReorderPlacement,
  ) => void;
  onSteer: (messageId: MessageId) => void;
}) {
  const hasMessages = props.messages.length > 0;
  if (!hasMessages) {
    return null;
  }
  const [draggedMessageId, setDraggedMessageId] = useState<MessageId | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{
    messageId: MessageId;
    placement: QueueReorderPlacement;
  } | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<ReadonlyArray<MessageId> | null>(null);

  const baseOrderIds = useMemo(() => {
    const byId = new Map(props.messages.map((message) => [message.id, message] as const));
    const serverOrderIds = props.messages.map((message) => message.id);
    return optimisticOrder &&
      optimisticOrder.length === serverOrderIds.length &&
      optimisticOrder.every((id) => byId.has(id))
      ? optimisticOrder
      : serverOrderIds;
  }, [optimisticOrder, props.messages]);

  const previewOrderIds = useMemo(() => {
    if (!draggedMessageId || !dragOverTarget || draggedMessageId === dragOverTarget.messageId) {
      return baseOrderIds;
    }
    return moveMessageId(
      baseOrderIds,
      draggedMessageId,
      dragOverTarget.messageId,
      dragOverTarget.placement,
    );
  }, [baseOrderIds, dragOverTarget, draggedMessageId]);

  const orderedMessages = useMemo(() => {
    const byId = new Map(props.messages.map((message) => [message.id, message] as const));
    return baseOrderIds.map((id) => byId.get(id)).filter((value) => value !== undefined);
  }, [baseOrderIds, props.messages]);

  const serverOrderIds = useMemo(
    () => props.messages.map((message) => message.id),
    [props.messages],
  );

  const hasVisibleReorderPreview = draggedMessageId !== null && dragOverTarget !== null;
  const visiblePositionByMessageId = useMemo(() => {
    if (!hasVisibleReorderPreview) {
      return null;
    }
    return new Map(previewOrderIds.map((id, index) => [id, index + 1]));
  }, [hasVisibleReorderPreview, previewOrderIds]);

  const persistedPositionByMessageId = useMemo(
    () => new Map(serverOrderIds.map((id, index) => [id, index + 1])),
    [serverOrderIds],
  );

  useEffect(() => {
    if (!optimisticOrder) {
      return;
    }
    const currentOrder = serverOrderIds;
    const hasSameIds =
      currentOrder.length === optimisticOrder.length &&
      currentOrder.every((id) => optimisticOrder.includes(id));
    if (!hasSameIds) {
      setOptimisticOrder(null);
      return;
    }
    const isSettled = currentOrder.every((id, index) => id === optimisticOrder[index]);
    if (isSettled) {
      setOptimisticOrder(null);
    }
  }, [optimisticOrder, serverOrderIds]);

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
        {orderedMessages.map((message, index) => {
          const textPreview = message.prompt.replace(/\s+/g, " ").trim();
          const preview = textPreview.length > 0 ? textPreview : "Queue Message";
          const isSteered = props.steerMessageId === message.id;
          return (
            <div
              key={message.id}
              className={cn(
                "group/queue-row relative grid min-h-[42px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-3 py-1.5 last:border-b-0",
                draggedMessageId === message.id && "opacity-70",
                draggedMessageId !== null &&
                  dragOverTarget?.messageId === message.id &&
                  draggedMessageId !== message.id &&
                  "bg-muted/25",
              )}
              onDragOver={(event) => {
                event.preventDefault();
                if (!draggedMessageId) {
                  return;
                }
                const nextPlacement = resolveDropPlacement(event);
                setDragOverTarget((current) => {
                  if (current?.messageId === message.id && current.placement === nextPlacement) {
                    return current;
                  }
                  return { messageId: message.id, placement: nextPlacement };
                });
              }}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId =
                  (event.dataTransfer.getData("text/plain") as MessageId) ?? draggedMessageId;
                if (!draggedId || draggedId === message.id) {
                  setDraggedMessageId(null);
                  setDragOverTarget(null);
                  return;
                }
                const placement = resolveDropPlacement(event);
                const nextOrder = moveMessageId(baseOrderIds, draggedId, message.id, placement);
                setOptimisticOrder(nextOrder);
                props.onReorder(draggedId, message.id, placement);
                setDraggedMessageId(null);
                setDragOverTarget(null);
              }}
            >
              {draggedMessageId !== null &&
              dragOverTarget?.messageId === message.id &&
              dragOverTarget.placement === "before" &&
              draggedMessageId !== message.id ? (
                <span className="pointer-events-none absolute inset-x-2 top-0 h-px bg-primary/70" />
              ) : null}
              {draggedMessageId !== null &&
              dragOverTarget?.messageId === message.id &&
              dragOverTarget.placement === "after" &&
              draggedMessageId !== message.id ? (
                <span className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-primary/70" />
              ) : null}
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/55 opacity-0 transition-opacity group-hover/queue-row:opacity-100 group-focus-within/queue-row:opacity-100 active:cursor-grabbing"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", message.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedMessageId(message.id);
                    setDragOverTarget({ messageId: message.id, placement: "before" });
                  }}
                  onDragEnd={() => {
                    setDraggedMessageId(null);
                    setDragOverTarget(null);
                  }}
                  aria-label="Reorder queued message"
                  title="Reorder queued message"
                >
                  <GripVerticalIcon className="size-3.5" />
                </button>
                <span className="shrink-0 text-muted-foreground/62">↳</span>
                <span className="shrink-0 rounded-sm border border-border/55 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/72">
                  {(() => {
                    const visiblePosition = visiblePositionByMessageId?.get(message.id);
                    const persistedPosition =
                      persistedPositionByMessageId.get(message.id) ?? index + 1;
                    const displayPosition = visiblePosition ?? persistedPosition;
                    const isNext = displayPosition === 1;
                    const positionLabel = isNext ? "Next" : `#${displayPosition}`;
                    if (!visiblePosition || visiblePosition === persistedPosition) {
                      return positionLabel;
                    }
                    return `${positionLabel} • was #${persistedPosition}`;
                  })()}
                </span>
                <p className="truncate text-[13px] font-medium text-foreground/88">{preview}</p>
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
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn(
                    "h-7 rounded-md px-2.5 text-[12px] font-medium transition-all duration-200",
                    isSteered
                      ? "border border-primary/35 bg-primary/12 text-primary hover:bg-primary/16 motion-safe:animate-pulse"
                      : "text-muted-foreground/80 hover:bg-muted/35 hover:text-foreground",
                  )}
                  onClick={() => {
                    setOptimisticOrder((current) => {
                      const ids = [...(current ?? baseOrderIds)];
                      const currentIndex = ids.indexOf(message.id);
                      if (currentIndex <= 0) {
                        return current;
                      }
                      const [selected] = ids.splice(currentIndex, 1);
                      if (!selected) {
                        return current;
                      }
                      ids.unshift(selected);
                      return ids;
                    });
                    props.onSteer(message.id);
                  }}
                  aria-label={isSteered ? "Steering queued message" : "Steer queued message"}
                >
                  <span
                    className={cn(
                      "mr-1",
                      isSteered ? "text-primary/90" : "text-muted-foreground/65",
                    )}
                  >
                    ↳
                  </span>
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
