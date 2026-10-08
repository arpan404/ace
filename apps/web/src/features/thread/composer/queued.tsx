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
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import type { PendingQueued } from "./queued-pending.ts";
import { queuedText, type QueueControls } from "./use-queue.ts";

/**
 * The daemon's queue for this thread, above the composer: each waiting message with
 * Send now, Edit, Move up and down and Remove. A message the daemon can't vouch for (it may
 * have reached the agent before a restart) can be sent again or removed. A message just queued shows at
 * once, from this window's outbox, and can be changed once the daemon has it (UX audit SY-7).
 * After Stop the queue waits ("paused after Stop") rather than dropping anything (CMP-1).
 */
export function QueuedPills(props: { queue: QueueControls; pending?: readonly PendingQueued[] }) {
  const { page, messages } = props.queue;
  const pending = props.pending ?? [];
  if (!messages.length && !pending.length) return null;
  const hidden = page ? page.total - page.messages.length : 0;
  const stopped = !!page?.paused && String(page.reason) === "stopped";
  return (
    <div className="mb-2 flex flex-col items-center gap-1.5">
      <ul aria-label="Queued messages" className="flex w-full flex-col items-center gap-1.5">
        {messages.map((message, index) => (
          <QueuedPill
            key={message.id}
            message={message}
            index={index}
            last={index === messages.length - 1 && !pending.length}
            stopped={stopped}
            queue={props.queue}
          />
        ))}
        {pending.map((message) => (
          <SavingPill key={message.id} message={message} />
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
function SavingPill(props: { message: PendingQueued }) {
  const text = queuedText(props.message);
  return (
    <li
      aria-busy
      className="fx-rise-in inline-flex min-h-8 max-w-full items-center gap-2 px-2.5 text-sm text-muted-foreground"
    >
      <Icon icon={ClockIcon} size={14} />
      <span className="shrink-0">Queued</span>
      <span className="min-w-0 truncate font-medium text-foreground">
        {text || "Attached files"}
      </span>
      <Spinner label="Saving your message" />
    </li>
  );
}

function QueuedPill(props: {
  message: QueuedMessage;
  index: number;
  last: boolean;
  /** The queue waits because the person pressed Stop. */
  stopped: boolean;
  queue: QueueControls;
}) {
  const { message, queue } = props;
  const [editing, setEditing] = useState(false);
  const text = queuedText(message);
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
            // The pill shows the new text at once; a refusal takes it back with a toast.
            setEditing(false);
            await queue.edit(message, next);
          }}
        />
      </li>
    );
  return (
    <li className="fx-rise-in inline-flex min-h-8 max-w-full items-center gap-2 px-2.5 text-sm text-muted-foreground">
      <StatusLabel
        tone={uncertain ? "needs-you" : "idle"}
        mark={
          <Icon icon={uncertain ? WarningIcon : props.stopped ? PauseIcon : ClockIcon} size={14} />
        }
        label={
          uncertain ? "May have been sent" : props.stopped ? "Queued · paused after Stop" : "Queued"
        }
      />
      <span className="min-w-0 truncate font-medium text-foreground">
        {text || "Attached files"}
      </span>
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
            <MenuItem icon={<Icon icon={LightningIcon} />} onClick={() => queue.sendNow(message)}>
              Send now
            </MenuItem>
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
            <MenuItem danger icon={<Icon icon={TrashIcon} />} onClick={() => queue.remove(message)}>
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
          label="Remove from queue"
          size="sm"
          className="size-5"
          onClick={() => queue.remove(message)}
        />
      )}
    </li>
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
