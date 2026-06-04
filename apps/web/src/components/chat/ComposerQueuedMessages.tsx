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
  ClockIcon,
  CornerDownRightIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  GripVerticalIcon,
  HashIcon,
  ImageIcon,
  PencilIcon,
  TargetIcon,
  XIcon,
} from "lucide-react";
import { type MessageId, type ModelSelection } from "@ace/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { ActiveGoalState } from "../../session-logic";
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

function formatCompactNumber(value: number): string {
  const absoluteValue = Math.abs(value);
  const suffixes = [
    { threshold: 1_000_000_000_000, suffix: "T" },
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ] as const;
  const matchingSuffix = suffixes.find((entry) => absoluteValue >= entry.threshold);

  if (!matchingSuffix) {
    return new Intl.NumberFormat().format(value);
  }

  const compactValue = value / matchingSuffix.threshold;
  const maximumFractionDigits = Math.abs(compactValue) >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(compactValue)}${matchingSuffix.suffix}`;
}

function formatGoalTokens(goal: ActiveGoalState): string {
  if (goal.tokensUsed !== undefined && goal.tokenBudget !== undefined) {
    return `${formatCompactNumber(goal.tokensUsed)} / ${formatCompactNumber(goal.tokenBudget)} tokens`;
  }
  if (goal.tokensUsed !== undefined) {
    return `${formatCompactNumber(goal.tokensUsed)} tokens`;
  }
  if (goal.tokenBudget !== undefined) {
    return `${formatCompactNumber(goal.tokenBudget)} token budget`;
  }
  return "Not reported";
}

function formatGoalElapsedTime(goal: ActiveGoalState): string {
  if (goal.timeUsedSeconds !== undefined) {
    const totalSeconds = Math.max(0, Math.floor(goal.timeUsedSeconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }
  return "Not reported";
}

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

function QueueInlineMetric(props: { label: string; value: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-[11px] font-medium tabular-nums text-muted-foreground/66"
      aria-label={`${props.label}: ${props.value}`}
    >
      <span className="text-muted-foreground/42" aria-hidden="true">
        {props.children}
      </span>
      <span className="truncate">{props.value}</span>
    </span>
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

function GoalQueueRow(props: {
  goal: ActiveGoalState;
  onDelete: () => void;
  onEdit: (objective: string) => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftObjective, setDraftObjective] = useState(props.goal.objective);
  const trimmedDraft = draftObjective.trim();
  const saveDisabled = trimmedDraft.length === 0 || trimmedDraft === props.goal.objective;
  const elapsedTime = formatGoalElapsedTime(props.goal);
  const tokens = formatGoalTokens(props.goal);

  return (
    <>
      <div className={QUEUE_ROW_CLASS_NAME}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/25 bg-background/25 text-muted-foreground/58">
            <TargetIcon className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 sm:max-w-[min(36rem,52vw)]">
            <p className="truncate text-[12.5px] font-medium text-foreground/86">
              {props.goal.objective}
            </p>
          </div>
          <div className="hidden min-w-0 shrink-0 items-center gap-2.5 pl-1 sm:flex">
            <QueueInlineMetric label="Time" value={elapsedTime}>
              <ClockIcon className="size-3" />
            </QueueInlineMetric>
            <QueueInlineMetric label="Tokens" value={tokens}>
              <HashIcon className="size-3" />
            </QueueInlineMetric>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {props.goal.status === "paused" ? (
            <QueueActionButton label="Resume goal" tooltip="Resume goal" onClick={props.onResume}>
              <PlayCircleIcon className="size-3.5" />
            </QueueActionButton>
          ) : props.goal.status !== "completed" ? (
            <QueueActionButton label="Pause goal" tooltip="Pause goal" onClick={props.onPause}>
              <PauseCircleIcon className="size-3.5" />
            </QueueActionButton>
          ) : null}
          <QueueActionButton
            label="Edit goal"
            tooltip="Edit goal"
            onClick={() => {
              setDraftObjective(props.goal.objective);
              setEditing(true);
            }}
          >
            <PencilIcon className="size-3.5" />
          </QueueActionButton>
          <QueueActionButton
            label="Delete goal"
            tooltip="Delete goal"
            destructive
            onClick={props.onDelete}
          >
            <XIcon className="size-3.5" />
          </QueueActionButton>
        </div>
      </div>

      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!open) {
            setDraftObjective(props.goal.objective);
          }
          setEditing(open);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit goal</DialogTitle>
            <DialogDescription>Update the objective used for the active goal.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <textarea
              value={draftObjective}
              onChange={(event) => setDraftObjective(event.target.value)}
              className="min-h-28 w-full resize-none rounded-lg border border-border/55 bg-background/70 px-3 py-2.5 text-sm leading-6 outline-none transition-colors focus:border-ring/60 focus:ring-2 focus:ring-ring/12"
              aria-label="Edit goal objective"
              autoFocus
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraftObjective(props.goal.objective);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={saveDisabled}
              onClick={() => {
                if (saveDisabled) return;
                props.onEdit(trimmedDraft);
                setEditing(false);
              }}
            >
              Save goal
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
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
  activeGoal?: ActiveGoalState | null;
  steerMessageId?: MessageId | null;
  onEdit: (messageId: MessageId) => void;
  onDelete: (messageId: MessageId) => void;
  onClearAll: () => void;
  onReorder: (draggedMessageId: MessageId, targetMessageId: MessageId) => void;
  onDeleteGoal?: () => void;
  onEditGoal?: (objective: string) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  canSendNow?: boolean;
  onSend?: (messageId: MessageId) => void;
  onSteer: (messageId: MessageId) => void;
}) {
  const hasGoal = props.activeGoal !== null && props.activeGoal !== undefined;
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

  if (!hasGoal && !hasMessages) {
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
        {props.activeGoal ? (
          <GoalQueueRow
            goal={props.activeGoal}
            onDelete={props.onDeleteGoal ?? (() => {})}
            onEdit={props.onEditGoal ?? (() => {})}
            onPause={props.onPauseGoal ?? (() => {})}
            onResume={props.onResumeGoal ?? (() => {})}
          />
        ) : null}
        {hasMessages ? (
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
        ) : null}
      </div>
    </section>
  );
}
