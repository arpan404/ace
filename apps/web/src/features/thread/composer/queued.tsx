import type { Attachment } from "@ace/protocol";
import {
  ArrowBendUpRightIcon,
  DotsSixVerticalIcon,
  PencilSimpleIcon,
  QueueIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { PendingQueued } from "./queued-pending.ts";
import { QueuedAttachments } from "./queued-attachments.tsx";
import { queuedText, type QueueControls } from "./use-queue.ts";
import { useComposerCompact } from "./composer-compact.ts";
import { beginQueueEdit, cancelQueueEdit, useQueueEdit } from "./queue-edit.ts";
const handleStyle =
  "focus-ring inline-grid size-5 shrink-0 cursor-grab place-items-center rounded-sm text-subtle-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing aria-disabled:cursor-default aria-disabled:opacity-40";

/** Every queued message: the listed ones, this window's on their way, and those behind Load more. */
export function queuedCount(queue: QueueControls, pending: readonly PendingQueued[]): number {
  const listed = new Set(queue.messages.map((message) => message.id));
  const hidden = Math.max(0, (queue.page?.total ?? 0) - (queue.page?.messages.length ?? 0));
  return (
    queue.messages.length + pending.filter((message) => !listed.has(message.id)).length + hidden
  );
}

/**
 * The queue in the composer's strip: "Queued · 2" with the strip's indicators, why it is held
 * (`notice`), then a bounded list of messages to reorder, edit, steer in or remove.
 */
export function QueuedTray(props: {
  threadId: string;
  queue: QueueControls;
  pending: readonly PendingQueued[];
  attachments?: readonly Attachment[];
  steerReason?: string | undefined;
  /** Why the queue is held, with its way out. */
  notice?: ReactNode;
  /** The strip's other items, on the header row. */
  indicators?: ReactNode;
  /** Put the caret in the composer, where an edit happens. */
  onEditInComposer?(): void;
}) {
  const { queue } = props;
  const compact = useComposerCompact();
  const { storage } = useLayout();
  const session = useQueueEdit(props.threadId);
  const editing = session?.message;
  const [announcement, announce] = useState("");
  const restoreFocus = useRef<{ id: string; handle: HTMLButtonElement } | undefined>(undefined);
  const drag = useRef<{ id: string; revision: number | undefined; order: string } | undefined>(
    undefined,
  );
  const hintId = useId();
  const listed = new Set(queue.messages.map((message) => message.id));
  const pending = props.pending.filter((message) => !listed.has(message.id));
  const messages = [...queue.messages, ...pending];
  const hidden = Math.max(0, (queue.page?.total ?? 0) - (queue.page?.messages.length ?? 0));
  const count = messages.length + hidden;
  const stopped = !!queue.page?.paused && queue.page.reason === "stopped";
  const order = queue.messages.map((message) => message.id).join("\n");
  const moving = queue.messages.some((message) => queue.busy(message.id));
  const uncertain = queue.messages.some((message) => message.state === "uncertain");
  useLayoutEffect(() => {
    const cancelOnFocus = (event: FocusEvent) => {
      if (restoreFocus.current && event.target !== restoreFocus.current.handle)
        restoreFocus.current = undefined;
    };
    document.addEventListener("focusin", cancelOnFocus);
    return () => document.removeEventListener("focusin", cancelOnFocus);
  }, []);
  useLayoutEffect(() => {
    const target = restoreFocus.current;
    if (!target) return;
    if (document.activeElement !== document.body && document.activeElement !== target.handle) {
      restoreFocus.current = undefined;
      return;
    }
    if (queue.messages.some((message) => message.id === target.id) && target.handle.isConnected)
      target.handle.focus();
    if (!moving) restoreFocus.current = undefined;
  }, [queue.messages, moving]);
  const move = (index: number, destination: number, handle?: HTMLButtonElement) => {
    const message = queue.messages[index];
    if (
      !message ||
      moving ||
      uncertain ||
      index < 0 ||
      index >= queue.messages.length ||
      destination < 0 ||
      destination >= queue.messages.length ||
      index === destination
    )
      return;
    restoreFocus.current = handle ? { id: message.id, handle } : undefined;
    queue.moveTo(index, destination);
    announce(`Moved queued message to position ${destination + 1}.`);
  };
  return (
    <>
      <section aria-label="Message queue" className="w-full text-xs text-muted-foreground">
        <div className="flex h-5.5 min-w-0 items-center gap-1.5 px-1">
          <Icon icon={QueueIcon} size={12} className="shrink-0" />
          <span className="min-w-0 truncate">
            Queued
            {count > 0 && (
              <span className="tabular-nums" aria-label={`, ${count} queued messages`}>
                {" "}
                · {count}
              </span>
            )}
          </span>
          {props.indicators}
        </div>
        {props.notice}
        <div className="max-h-48 overflow-y-auto">
          <p id={hintId} className="sr-only">
            Drag to reorder, or focus a handle and press Alt+Arrow Up or Alt+Arrow Down.
          </p>
          {session?.newer !== undefined && (
            <div role="status" aria-label="Changed on another device" className="px-1 py-0.5">
              <p className="text-foreground">
                It changed on another device. Your edit is kept: saving replaces what it says now.
              </p>
              <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                {session.newer}
              </p>
            </div>
          )}
          {editing && !messages.some((message) => message.id === editing.id) && (
            // Its row isn't shown (sent, or moved past the loaded page): Cancel still needs a home.
            <p role="status" className="flex items-center gap-1 px-1 py-0.5 text-subtle-foreground">
              <span className="min-w-0 flex-1 truncate">
                {session?.held
                  ? "Editing the message that wasn't sent."
                  : queue.allMessages.some((message) => message.id === editing.id)
                    ? "Editing a message further down the queue."
                    : "The message you're editing has left the queue."}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  cancelQueueEdit(props.threadId);
                  props.onEditInComposer?.();
                }}
              >
                Cancel
              </Button>
            </p>
          )}
          <ul aria-label="Queued messages">
            {messages.map((message, index) => {
              const saving = "saving" in message;
              const ambiguous = !saving && message.state === "uncertain";
              const busy = saving || queue.busy(message.id);
              const edited = editing?.id === message.id;
              const text = queuedText(message) || "Attached files";
              const reason = saving
                ? "This message is still being saved."
                : busy
                  ? "This message is being updated."
                  : props.steerReason;
              return (
                <li
                  key={message.id}
                  data-queue-id={message.id}
                  aria-busy={busy}
                  aria-label={
                    saving
                      ? "Saving queued message"
                      : ambiguous
                        ? "This message may have been sent. Sending again may deliver it twice."
                        : stopped
                          ? "Queued message, paused after Stop"
                          : "Queued message, not yet sent"
                  }
                  className={cn(
                    "flex min-h-6.5 min-w-0 items-center gap-0.5 rounded-sm py-px",
                    edited && "bg-accent",
                  )}
                  onDragOver={(event) => {
                    if (drag.current && !saving && !moving && !uncertain) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const start = drag.current;
                    drag.current = undefined;
                    if (!start || saving) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (start.revision !== queue.page?.revision || start.order !== order) {
                      announce("The queue changed. Try moving the message again.");
                      return;
                    }
                    move(
                      queue.messages.findIndex((entry) => entry.id === start.id),
                      index,
                    );
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Reorder queued message ${index + 1}`}
                    aria-describedby={hintId}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    aria-disabled={saving || moving || uncertain}
                    draggable={!saving && !moving && !uncertain}
                    className={handleStyle}
                    onDragStart={(event) => {
                      if (saving || moving || uncertain) {
                        event.preventDefault();
                        return;
                      }
                      drag.current = { id: message.id, revision: queue.page?.revision, order };
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", message.id);
                    }}
                    onDragEnd={() => {
                      drag.current = undefined;
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                      event.preventDefault();
                      move(index, index + (event.key === "ArrowUp" ? -1 : 1), event.currentTarget);
                    }}
                  >
                    <Icon icon={DotsSixVerticalIcon} size={12} />
                  </button>
                  <div className="min-w-0 flex-1 px-1">
                    <p className="truncate text-foreground/80" title={text}>
                      {text}
                    </p>
                    <QueuedAttachments
                      threadId={props.threadId}
                      context={message.context}
                      metadata={props.attachments ?? []}
                    />
                  </div>
                  {saving && <span>Saving…</span>}
                  {ambiguous && <span>May have been sent</span>}
                  {edited ? (
                    <>
                      <span className="shrink-0 px-1 text-subtle-foreground">
                        Editing in composer
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        title="Stop editing and bring back what you were writing"
                        onClick={() => {
                          cancelQueueEdit(props.threadId);
                          props.onEditInComposer?.();
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <IconButton
                      icon={PencilSimpleIcon}
                      label="Edit queued message"
                      size="sm"
                      disabled={busy || ambiguous}
                      reason={
                        ambiguous
                          ? "This message may have been sent. Remove it or send it again."
                          : undefined
                      }
                      onClick={() => {
                        if (saving || "saving" in message) return;
                        if (beginQueueEdit(storage, props.threadId, message, queue.page?.revision))
                          props.onEditInComposer?.();
                      }}
                    />
                  )}
                  {ambiguous ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      title="This message may have been sent. Sending again may deliver it twice."
                      onClick={() => {
                        if (!saving) queue.resend(message);
                      }}
                    >
                      Send again
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0"
                      disabled={!!reason}
                      focusableWhenDisabled
                      aria-description={reason}
                      title={reason ?? "Send this message into the running turn"}
                      onClick={() => {
                        if (!saving) queue.sendNow(message);
                      }}
                    >
                      <Icon icon={ArrowBendUpRightIcon} size={12} />
                      {/* A phone keeps the room for the message: the arrow alone, still named. */}
                      <span className={compact ? "sr-only" : undefined}>Steer</span>
                    </Button>
                  )}
                  <IconButton
                    icon={XIcon}
                    label="Remove queued message"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (!saving) queue.remove(message);
                    }}
                  />
                </li>
              );
            })}
          </ul>
          {queue.page?.next && queue.loadMore && (
            <Button variant="ghost" size="xs" disabled={queue.loadingMore} onClick={queue.loadMore}>
              Load more queued messages
            </Button>
          )}
          {hidden > 0 && (
            <p className="px-1 py-0.5 text-subtle-foreground">
              {hidden} more queued {hidden === 1 ? "message" : "messages"}
            </p>
          )}
          {queue.failed && (
            <p role="status" className="px-1 py-0.5">
              Couldn't refresh the queue.{" "}
              <Button variant="ghost" size="xs" onClick={queue.refresh}>
                Retry
              </Button>
            </p>
          )}
        </div>
      </section>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
