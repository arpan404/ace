import {
  closestCorners,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconTerminal } from "@tabler/icons-react";
import { GripVerticalIcon, ImageIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type MessageId, type ModelSelection } from "@ace/contracts";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ComposerQueuedMessageItem {
  id: MessageId;
  prompt: string;
  images: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<{ id: string }>;
  modelSelection: ModelSelection;
}

function SortableQueuedMessageRow(props: {
  message: ComposerQueuedMessageItem;
  index: number;
  draggedMessageId: MessageId | null;
  persistedPositionByMessageId: ReadonlyMap<MessageId, number>;
  steerMessageId: MessageId | null | undefined;
  onEdit: (messageId: MessageId) => void;
  onDelete: (messageId: MessageId) => void;
  onSteer: (messageId: MessageId) => void;
  onOptimisticallySteer: (messageId: MessageId) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id: props.message.id });
  const textPreview = props.message.prompt.replace(/\s+/g, " ").trim();
  const preview = textPreview.length > 0 ? textPreview : "Queue Message";
  const isSteered = props.steerMessageId === props.message.id;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/queue-row relative grid min-h-[42px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-3 py-1.5 last:border-b-0",
        props.draggedMessageId === props.message.id && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/55 opacity-0 transition-opacity group-hover/queue-row:opacity-100 group-focus-within/queue-row:opacity-100 active:cursor-grabbing"
          {...attributes}
          {...listeners}
          aria-label="Reorder queued message"
          title="Reorder queued message"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span className="shrink-0 text-muted-foreground/62">↳</span>
        <span className="shrink-0 rounded-sm border border-border/55 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/72">
          {(() => {
            const persistedPosition =
              props.persistedPositionByMessageId.get(props.message.id) ?? props.index + 1;
            const displayPosition = props.index + 1;
            const isNext = displayPosition === 1;
            const positionLabel = isNext ? "Next" : `#${displayPosition}`;
            if (displayPosition === persistedPosition) {
              return positionLabel;
            }
            return `${positionLabel} • was #${persistedPosition}`;
          })()}
        </span>
        <p className="truncate text-[13px] font-medium text-foreground/88">{preview}</p>
        {props.message.images.length > 0 ? (
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border/55 bg-background/80 text-muted-foreground/70">
            <ImageIcon className="size-3" />
          </span>
        ) : null}
        {props.message.terminalContexts.length > 0 ? (
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
            props.onOptimisticallySteer(props.message.id);
            props.onSteer(props.message.id);
          }}
          aria-label={isSteered ? "Steering queued message" : "Steer queued message"}
        >
          <span className={cn("mr-1", isSteered ? "text-primary/90" : "text-muted-foreground/65")}>
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
            props.onEdit(props.message.id);
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
            props.onDelete(props.message.id);
          }}
          aria-label="Delete queued message"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function ComposerQueuedMessages(props: {
  messages: ReadonlyArray<ComposerQueuedMessageItem>;
  className?: string;
  steerMessageId?: MessageId | null;
  onEdit: (messageId: MessageId) => void;
  onDelete: (messageId: MessageId) => void;
  onClearAll: () => void;
  onReorder: (draggedMessageId: MessageId, targetMessageId: MessageId) => void;
  onSteer: (messageId: MessageId) => void;
}) {
  const hasMessages = props.messages.length > 0;
  if (!hasMessages) {
    return null;
  }
  const [draggedMessageId, setDraggedMessageId] = useState<MessageId | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<ReadonlyArray<MessageId> | null>(null);
  const queueDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const queueCollisionDetection = useMemo<CollisionDetection>(() => closestCorners, []);

  const baseOrderIds = useMemo(() => {
    const byId = new Map(props.messages.map((message) => [message.id, message] as const));
    const serverOrderIds = props.messages.map((message) => message.id);
    return optimisticOrder &&
      optimisticOrder.length === serverOrderIds.length &&
      optimisticOrder.every((id) => byId.has(id))
      ? optimisticOrder
      : serverOrderIds;
  }, [optimisticOrder, props.messages]);

  const orderedMessages = useMemo(() => {
    const byId = new Map(props.messages.map((message) => [message.id, message] as const));
    return baseOrderIds.map((id) => byId.get(id)).filter((value) => value !== undefined);
  }, [baseOrderIds, props.messages]);

  const serverOrderIds = useMemo(
    () => props.messages.map((message) => message.id),
    [props.messages],
  );

  const persistedPositionByMessageId = useMemo(
    () => new Map(serverOrderIds.map((id, index) => [id, index + 1])),
    [serverOrderIds],
  );
  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedMessageId(null);
    const activeId = String(event.active.id) as MessageId;
    const overId = event.over ? (String(event.over.id) as MessageId) : null;
    if (!overId || activeId === overId) {
      return;
    }
    const activeIndex = baseOrderIds.indexOf(activeId);
    const overIndex = baseOrderIds.indexOf(overId);
    if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
      return;
    }
    setOptimisticOrder(arrayMove([...baseOrderIds], activeIndex, overIndex));
    props.onReorder(activeId, overId);
  };

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
        "mb-3 overflow-hidden rounded-[14px] border border-border/60 bg-card",
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
        <div className="flex items-center gap-1">
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
      </div>
      <div className="max-h-[126px] overflow-y-auto">
        <DndContext
          sensors={queueDnDSensors}
          collisionDetection={queueCollisionDetection}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragStart={(event) => {
            setDraggedMessageId(String(event.active.id) as MessageId);
          }}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setDraggedMessageId(null);
          }}
        >
          <SortableContext items={[...baseOrderIds]} strategy={verticalListSortingStrategy}>
            {orderedMessages.map((message, index) => {
              return (
                <SortableQueuedMessageRow
                  key={message.id}
                  message={message}
                  index={index}
                  draggedMessageId={draggedMessageId}
                  persistedPositionByMessageId={persistedPositionByMessageId}
                  steerMessageId={props.steerMessageId}
                  onEdit={props.onEdit}
                  onDelete={props.onDelete}
                  onSteer={props.onSteer}
                  onOptimisticallySteer={(messageId) => {
                    setOptimisticOrder((current) => {
                      const ids = [...(current ?? baseOrderIds)];
                      const currentIndex = ids.indexOf(messageId);
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
                  }}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}
