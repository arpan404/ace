import type { Attachment, QueuedMessage } from "@ace/protocol";
import {
  ArrowBendUpRightIcon,
  DotsSixVerticalIcon,
  PencilSimpleIcon,
  TrayIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Suspense, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { PendingQueued } from "./queued-pending.ts";
import { QueuedAttachments } from "./queued-attachments.tsx";
import { queuedText, type QueueControls } from "./use-queue.ts";
import { useComposerCompact } from "./composer-compact.ts";

const Edit = deferredComponent(() =>
  import("./queued-edit.tsx").then((module) => module.QueuedEdit),
);
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
  /** The message being edited, held by the strip so the editor outlives an emptied queue. */
  editing: QueuedMessage | undefined;
  onEdit(message: QueuedMessage | undefined): void;
}) {
  const { queue } = props;
  const compact = useComposerCompact();
  const { editing, onEdit: setEditing } = props;
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
          <Icon icon={TrayIcon} size={12} className="shrink-0" />
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
        <div className="max-h-48 overflow-y-auto overscroll-contain">
          <p id={hintId} className="sr-only">
            Drag to reorder, or focus a handle and press Alt+Arrow Up or Alt+Arrow Down.
          </p>
          <ul aria-label="Queued messages">
            {messages.map((message, index) => {
              const saving = "saving" in message;
              const ambiguous = !saving && message.state === "uncertain";
              const busy = saving || queue.busy(message.id);
              const text = queuedText(message) || "Attached files";
              const reason = saving
                ? "This message is still being saved."
                : busy
                  ? "This message is being updated."
                  : message.requiresNextTurn
                    ? "This message changes model or turn options and must wait for the next turn."
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
                  className="flex min-h-6.5 min-w-0 items-center gap-0.5 py-px"
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
                      if (!saving) setEditing(message);
                    }}
                  />
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
      {editing && (
        <Suspense fallback={null}>
          <Edit.Component message={editing} queue={queue} onClose={() => setEditing(undefined)} />
        </Suspense>
      )}
    </>
  );
}
