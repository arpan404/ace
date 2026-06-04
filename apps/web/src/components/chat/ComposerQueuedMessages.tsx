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
import {
  ArrowUpIcon,
  CornerDownRightIcon,
  GripVerticalIcon,
  ImageIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { type MessageId, type ModelSelection } from "@ace/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatQueuedComposerMessagePreview } from "~/lib/chat/queuedComposerPreview";

export interface ComposerQueuedMessageItem {
  id: MessageId;
  prompt: string;
  images: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<{ id: string }>;
  modelSelection: ModelSelection;
}

const QUEUE_ICON_BUTTON_CLASS_NAME =
  "size-6 rounded-md text-muted-foreground/55 opacity-70 transition-all duration-150 hover:bg-muted/35 hover:text-foreground hover:opacity-100 group-hover/queue-row:opacity-100 group-focus-within/queue-row:opacity-100";
const QUEUE_ROW_CLASS_NAME =
  "group/queue-row relative grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border/30 px-2.5 py-1.5 last:border-b-0";

function QueueActionButton(props: {
  label: string;
  tooltip: string;
  destructive?: boolean;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className={cn(
              QUEUE_ICON_BUTTON_CLASS_NAME,
              props.destructive && "hover:bg-destructive/10 hover:text-destructive",
              props.disabled && "pointer-events-none opacity-35",
            )}
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label={props.label}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function QueueAttachmentBadge(props: { label: string; count: number; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/25 bg-background/25 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/68" />
        }
      >
        {props.children}
        <span>{props.count}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function SortableQueuedMessageRow(props: {
  message: ComposerQueuedMessageItem;
  draggedMessageId: MessageId | null;
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
        QUEUE_ROW_CLASS_NAME,
        isSteered && "bg-primary/[0.035]",
        props.draggedMessageId === props.message.id && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex w-5 shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  ref={setActivatorNodeRef}
                  className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/36 opacity-55 transition-all duration-150 hover:bg-muted/35 hover:text-muted-foreground/75 hover:opacity-100 active:cursor-grabbing group-focus-within/queue-row:opacity-100"
                  {...attributes}
                  {...listeners}
                  aria-label="Reorder queued message"
                />
              }
            >
              <GripVerticalIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Reorder queued message</TooltipPopup>
          </Tooltip>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground/86">
            {preview}
          </p>
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            {props.message.images.length > 0 ? (
              <QueueAttachmentBadge
                label={
                  props.message.images.length === 1
                    ? "1 image attachment"
                    : `${props.message.images.length} image attachments`
                }
                count={props.message.images.length}
              >
                <ImageIcon className="size-3" />
              </QueueAttachmentBadge>
            ) : null}
            {props.message.terminalContexts.length > 0 ? (
              <QueueAttachmentBadge
                label={
                  props.message.terminalContexts.length === 1
                    ? "1 terminal context"
                    : `${props.message.terminalContexts.length} terminal contexts`
                }
                count={props.message.terminalContexts.length}
              >
                <IconTerminal className="size-3" />
              </QueueAttachmentBadge>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {props.canSendNow ? (
          <QueueActionButton
            label="Send queued message"
            tooltip="Send queued message"
            onClick={() => {
              props.onSend(props.message.id);
            }}
          >
            <ArrowUpIcon className="size-3.5 text-primary" />
          </QueueActionButton>
        ) : null}
        {showSteerAction ? (
          <QueueActionButton
            label={isSteered ? "Steering message" : "Steer queued message"}
            tooltip={isSteered ? "Move back to queue" : "Steer queued message"}
            onClick={() => {
              if (!isSteered) {
                props.onOptimisticallySteer(props.message.id);
              }
              props.onSteer(props.message.id);
            }}
          >
            <CornerDownRightIcon
              className={cn(
                "size-3.5",
                isSteered
                  ? "animate-pulse text-primary"
                  : "text-muted-foreground/60 group-hover/queue-row:text-foreground",
              )}
            />
          </QueueActionButton>
        ) : null}
        <QueueActionButton
          label="Edit queued message"
          tooltip="Edit queued message"
          onClick={() => {
            props.onEdit(props.message.id);
          }}
        >
          <PencilIcon className="size-3.5" />
        </QueueActionButton>
        <QueueActionButton
          label="Delete queued message"
          tooltip="Delete queued message"
          destructive
          onClick={() => {
            props.onDelete(props.message.id);
          }}
        >
          <XIcon className="size-3.5" />
        </QueueActionButton>
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
    const nextOrderedMessages: ComposerQueuedMessageItem[] = [];
    for (const id of baseOrderIds) {
      const message = byId.get(id);
      if (message) {
        nextOrderedMessages.push(message);
      }
    }
    return nextOrderedMessages;
  }, [baseOrderIds, props.messages]);

  const serverOrderIds = useMemo(
    () => props.messages.map((message) => message.id),
    [props.messages],
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
    let hasSameIds = currentOrder.length === optimisticOrder.length;
    if (hasSameIds) {
      const optimisticOrderSet = new Set(optimisticOrder);
      for (const id of currentOrder) {
        if (!optimisticOrderSet.has(id)) {
          hasSameIds = false;
          break;
        }
      }
    }
    if (!hasSameIds) {
      setOptimisticOrder(null);
      return;
    }
    let isSettled = true;
    for (const [index, id] of currentOrder.entries()) {
      if (id !== optimisticOrder[index]) {
        isSettled = false;
        break;
      }
    }
    if (isSettled) {
      setOptimisticOrder(null);
    }
  }, [optimisticOrder, serverOrderIds]);

  if (!hasMessages) {
    return null;
  }

  return (
    <section
      className={cn(
        "mb-2 overflow-hidden rounded-xl border border-border/25 bg-input/92 shadow-[0_1px_0_rgba(255,255,255,0.025)_inset]",
        props.className,
      )}
    >
      <div className="max-h-[148px] overflow-y-auto">
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
            {orderedMessages.map((message) => {
              return (
                <SortableQueuedMessageRow
                  key={message.id}
                  message={message}
                  draggedMessageId={draggedMessageId}
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
