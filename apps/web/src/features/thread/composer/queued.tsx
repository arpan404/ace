import type { QueuedMessage } from "@ace/protocol";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ClockIcon,
  DotsThreeIcon,
  LightningIcon,
  PauseIcon,
  PencilSimpleIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Suspense, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import type { PendingQueued } from "./queued-pending.ts";
import { queuedText, type QueueControls } from "./use-queue.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { MessageReferences } from "../items/message-references.tsx";
import { userBubble } from "../items/user-bubble.ts";
import { localAttachment } from "./send-store.ts";

const Attachments = deferredComponent(() =>
  import("@/components/attachment-message.tsx").then((module) => module.MessageAttachments),
);

/**
 * The daemon's queue at the transcript's tail: pending user bubbles with Send now and Take
 * back to composer, plus ordering and removal in the menu. A message the daemon can't vouch for (it may
 * have reached the agent before a restart) can be sent again or removed. A message just queued shows at
 * once, from this window's outbox, and can be changed once the daemon has it (UX audit SY-7).
 * After Stop the queue waits ("paused after Stop") rather than dropping anything (CMP-1).
 */
export function QueuedBubbles(props: { queue: QueueControls; pending?: readonly PendingQueued[] }) {
  const { page, messages } = props.queue;
  const listed = new Set(messages.map((message) => message.id));
  const pending = (props.pending ?? []).filter((message) => !listed.has(message.id));
  if (!messages.length && !pending.length) return null;
  const hidden = page ? page.total - page.messages.length : 0;
  const stopped = !!page?.paused && String(page.reason) === "stopped";
  return (
    <div className="mt-4 flex flex-col items-end gap-2">
      <ul aria-label="Queued messages" className="flex w-full flex-col gap-4">
        {[...messages, ...pending].map((message, index) => (
          <QueuedBubble
            key={message.id}
            message={message}
            index={index}
            last={index === messages.length + pending.length - 1}
            stopped={stopped}
            queue={props.queue}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-xs text-subtle-foreground">
          {hidden === 1 ? "1 more queued message" : `${hidden} more queued messages`}
        </p>
      )}
    </div>
  );
}

/** A queued message on its way to the daemon: shown, not yet changeable. */
function SavingBubble(props: { message: PendingQueued }) {
  const text = queuedText(props.message);
  return (
    <li
      aria-busy
      data-queue-id={props.message.id}
      className="fx-rise-in flex flex-col items-end gap-1 text-muted-foreground"
    >
      <PendingBody message={props.message} text={text} />
      <span className="flex items-center gap-1.5 pr-1 text-xs">
        <Icon icon={ClockIcon} size={12} /> Queued
        <Spinner label="Saving queued message" />
      </span>
    </li>
  );
}

function QueuedBubble(props: {
  message: QueuedMessage | PendingQueued;
  index: number;
  last: boolean;
  /** The queue waits because the person pressed Stop. */
  stopped: boolean;
  queue: QueueControls;
}) {
  const { message, queue } = props;
  const [editing, setEditing] = useState(false);
  const text = queuedText(message);
  if ("saving" in message) return <SavingBubble message={message} />;
  const uncertain = message.state === "uncertain";
  const busy = queue.busy(message.id);
  const files =
    (message.context?.attachments.length ?? 0) + (message.context?.mentions.length ?? 0);
  if (editing)
    return (
      <li className="w-full">
        <EditQueued
          text={text}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            // The bubble shows the new text at once; a refusal takes it back with a toast.
            setEditing(false);
            await queue.edit(message, next);
          }}
        />
      </li>
    );
  return (
    <li
      data-queue-id={message.id}
      className="fx-rise-in flex flex-col items-end gap-1 text-muted-foreground"
    >
      <PendingBody message={message} text={text} />
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1 pr-1 text-xs">
        <StatusLabel
          tone={uncertain ? "needs-you" : "idle"}
          mark={
            <Icon
              icon={uncertain ? WarningIcon : props.stopped ? PauseIcon : ClockIcon}
              size={14}
            />
          }
          label={
            uncertain
              ? "May have been sent"
              : props.stopped
                ? "Queued · paused after Stop"
                : "Queued"
          }
        />
        {files > 0 && (
          <span className="shrink-0 text-xs text-subtle-foreground">
            +{files} {files === 1 ? "file" : "files"}
          </span>
        )}
        {uncertain && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => queue.resend(message)}>
            Send again
          </Button>
        )}
        {!uncertain && (
          <IconButton
            icon={LightningIcon}
            label="Send now"
            tip="Send this message into the running turn"
            size="sm"
            disabled={busy}
            onClick={() => queue.sendNow(message)}
          />
        )}
        {!uncertain && (
          <Menu>
            <MenuTrigger
              render={
                <IconButton
                  icon={DotsThreeIcon}
                  label={`Queued message options: ${text}`}
                  size="sm"
                  className="size-5"
                  disabled={busy}
                />
              }
            />
            <MenuContent side="top" align="end" className="min-w-[190px]">
              <MenuItem icon={<Icon icon={PencilSimpleIcon} />} onClick={() => setEditing(true)}>
                Edit
              </MenuItem>
              <MenuItem
                icon={<Icon icon={ArrowUpIcon} />}
                disabled={props.index === 0}
                onClick={() => queue.move(props.index, -1)}
              >
                Move up
              </MenuItem>
              <MenuItem
                icon={<Icon icon={ArrowDownIcon} />}
                disabled={props.last}
                onClick={() => queue.move(props.index, 1)}
              >
                Move down
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Icon icon={TrashIcon} />}
                onClick={() => queue.remove(message)}
              >
                Remove
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        {busy ? (
          <Spinner label="Saving the change" />
        ) : (
          <IconButton
            icon={XIcon}
            label="Take back to composer"
            tip="Take back to composer, keeping your current draft"
            size="sm"
            onClick={() => queue.takeBack(message)}
          />
        )}
      </div>
    </li>
  );
}

function PendingBody(props: { message: QueuedMessage | PendingQueued; text: string }) {
  const files = props.message.context?.attachments.flatMap(({ sha256 }) => {
    const file = localAttachment(sha256);
    return file ? [file] : [];
  });
  return (
    <div className={`${userBubble} border border-dashed border-border/70 text-foreground`}>
      <Suspense fallback={null}>
        <Attachments.Component
          parts={props.message.input}
          local={files}
          className={props.text ? "mb-2" : undefined}
        />
      </Suspense>
      {props.text ? <MessageReferences parts={props.message.input} /> : "Attached files"}
    </div>
  );
}

/** A queued message opened for editing: Enter saves, Shift+Enter breaks a line, Esc cancels. */
function EditQueued(props: {
  text: string;
  busy: boolean;
  onSave(text: string): Promise<void>;
  onCancel(): void;
}) {
  const [text, setText] = useState(props.text);
  const save = () => {
    const next = text.trim();
    if (!next || props.busy) return;
    if (next === props.text.trim()) return props.onCancel();
    void props.onSave(next);
  };
  return (
    <div className="fx-rise-in flex flex-col gap-2 p-2">
      <Textarea
        aria-label="Edit queued message"
        value={text}
        autoFocus
        className="min-h-14 bg-transparent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!text.trim() || props.busy} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
