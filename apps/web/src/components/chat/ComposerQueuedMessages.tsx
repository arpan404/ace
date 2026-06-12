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
import { ArrowUpIcon, GripVerticalIcon, ImageIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type MessageId, type ModelSelection } from "@ace/contracts";
import { useMemo, useState } from "react";

import {
  APP_BADGE_CLASS_NAME,
  APP_COMPOSER_INSET_PANEL_CLASS_NAME,
  APP_INSET_BADGE_CLASS_NAME,
} from "~/lib/appChrome";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatQueuedComposerMessagePreview } from "~/lib/chat/queuedComposerPreview";

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
  canSendNow: boolean;
  onEdit: (messageId: MessageId) => void;
  onDelete: (messageId: MessageId) => void;
  onSend: (messageId: MessageId) => void;
  onSteer: (messageId: MessageId) => void;
  onOptimisticallySteer: (messageId: MessageId) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id: props.message.id });
  const preview = formatQueuedComposerMessagePreview({
    prompt: props.message.prompt,
    imageCount: props.message.images.length,
    terminalContextCount: props.message.terminalContexts.length,
  });
  const isSteered = props.steerMessageId === props.message.id;
  const showSteerAction = !props.canSendNow && (props.steerMessageId == null || isSteered);

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
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                ref={setActivatorNodeRef}
                className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/55 opacity-0 transition-opacity group-hover/queue-row:opacity-100 group-focus-within/queue-row:opacity-100 active:cursor-grabbing"
                {...attributes}
                {...listeners}
                aria-label="Reorder queued message"
              />
            }
          >
            <GripVerticalIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Reorder queued message</TooltipPopup>
        </Tooltip>
        <span className="shrink-0 text-muted-foreground/62">↳</span>
        <span className={cn("shrink-0", APP_INSET_BADGE_CLASS_NAME)}>
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
          <span className="glass-inset inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border/50 text-muted-foreground/70">
            <ImageIcon className="size-3" />
          </span>
        ) : null}
        {props.message.terminalContexts.length > 0 ? (
          <span className="glass-inset inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border/50 text-muted-foreground/70">
            <IconTerminal className="size-3" />
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {props.canSendNow ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-md bg-primary/10 px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/16 hover:text-primary"
                  onClick={() => {
                    props.onSend(props.message.id);
                  }}
                  aria-label="Send queued message"
                />
              }
            >
              <ArrowUpIcon className="mr-1 size-3.5" />
              Send
            </TooltipTrigger>
            <TooltipPopup side="top">Send queued message</TooltipPopup>
          </Tooltip>
        ) : null}
        {showSteerAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn(
                    "h-7 rounded-md px-2.5 text-[12px] font-medium transition-all duration-200",
                    isSteered
                      ? "animate-pulse border border-primary/35 bg-primary/12 text-primary hover:bg-primary/16"
                      : "text-muted-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                  onClick={() => {
                    if (!isSteered) {
                      props.onOptimisticallySteer(props.message.id);
                    }
                    props.onSteer(props.message.id);
                  }}
                  aria-label={isSteered ? "Steering message" : "Steer queued message"}
                />
              }
            >
              <span
                className={cn("mr-1", isSteered ? "text-primary/90" : "text-muted-foreground/65")}
              >
                ↳
              </span>
              {isSteered ? "Steering" : "Steer"}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isSteered ? "Move back to queue" : "Steer queued message"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-7 rounded-md text-muted-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground"
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
  canSendNow?: boolean;
  onSend?: (messageId: MessageId) => void;
  onSteer: (messageId: MessageId) => void;
}) {
  const hasMessages = props.messages.length > 0;
  const [draggedMessageId, setDraggedMessageId] = useState<MessageId | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<ReadonlyArray<MessageId> | null>(null);
  const queueDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const queueCollisionDetection = useMemo<CollisionDetection>(() => closestCorners, []);

  const serverOrderIds = useMemo(
    () => props.messages.map((message) => message.id),
    [props.messages],
  );
  const optimisticOrderIdSet =
    optimisticOrder && optimisticOrder.length === serverOrderIds.length
      ? new Set(optimisticOrder)
      : null;
  const optimisticOrderIsValid = Boolean(
    optimisticOrderIdSet && serverOrderIds.every((id) => optimisticOrderIdSet.has(id)),
  );
  const optimisticOrderIsSettled = Boolean(
    optimisticOrderIsValid &&
    optimisticOrder !== null &&
    serverOrderIds.length === optimisticOrder.length &&
    serverOrderIds.every((id, index) => id === optimisticOrder[index]),
  );
  const effectiveOptimisticOrder =
    optimisticOrderIsValid && !optimisticOrderIsSettled ? optimisticOrder : null;

  const baseOrderIds = useMemo(() => {
    const byId = new Map(props.messages.map((message) => [message.id, message] as const));
    return effectiveOptimisticOrder && effectiveOptimisticOrder.every((id) => byId.has(id))
      ? effectiveOptimisticOrder
      : serverOrderIds;
  }, [effectiveOptimisticOrder, props.messages, serverOrderIds]);

  const orderedMessages = useMemo(() => {
    const byId = new Map(props.messages.map((message) => [message.id, message] as const));
    const nextOrderedMessages: ComposerQueuedMessageItem[] = [];
    for (const id of baseOrderIds) {
      const message = byId.get(id);
      if (message) {
        nextOrderedMessages.push(message);
      }
    }
    return nextOrderedMessages;
  }, [baseOrderIds, props.messages]);

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

  if (!hasMessages) {
    return null;
  }

  return (
    <section className={cn("mb-3", APP_COMPOSER_INSET_PANEL_CLASS_NAME, props.className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/70 uppercase">
            Queue
          </span>
          <span className={APP_BADGE_CLASS_NAME}>{props.messages.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 rounded-md border border-transparent px-2 text-[10px] font-medium text-muted-foreground/65 hover:border-destructive/20 hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-45"
                  onClick={props.onClearAll}
                  disabled={!hasMessages}
                  aria-label="Clear queued messages"
                />
              }
            >
              Clear all
            </TooltipTrigger>
            <TooltipPopup side="top">Clear queue</TooltipPopup>
          </Tooltip>
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
                  canSendNow={props.canSendNow === true}
                  onEdit={props.onEdit}
                  onDelete={props.onDelete}
                  onSend={props.onSend ?? props.onSteer}
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
