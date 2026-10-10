import type { QueuedMessage } from "@ace/protocol";
import { ArrowUpIcon, XIcon } from "@phosphor-icons/react";
import { Suspense } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { PendingQueued } from "./queued-pending.ts";
import { queuedText, type QueueControls } from "./use-queue.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { MessageReferences } from "../items/message-references.tsx";
import { userBubble } from "../items/user-bubble.ts";
import { localAttachment } from "./send-store.ts";

const Attachments = deferredComponent(() =>
  import("@/components/attachment-message.tsx").then((module) => module.MessageAttachments),
);

/** Pending user bubbles remain in daemon order. Send delivers now; X restores the draft. */
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
        {[...messages, ...pending].map((message) => (
          <QueuedBubble key={message.id} message={message} stopped={stopped} queue={props.queue} />
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

function QueuedBubble(props: {
  message: QueuedMessage | PendingQueued;
  stopped: boolean;
  queue: QueueControls;
}) {
  const { message, queue } = props;
  const saving = "saving" in message;
  const uncertain = !saving && message.state === "uncertain";
  const busy = saving || queue.busy(message.id);
  const description = saving
    ? "Saving queued message"
    : uncertain
      ? "This message may have been sent. Sending again may deliver it twice."
      : props.stopped
        ? "Queued message, paused after Stop"
        : "Queued message, not yet sent";
  return (
    <li
      aria-busy={busy}
      aria-label={description}
      data-queue-id={message.id}
      className="fx-rise-in flex flex-col items-end gap-1 text-muted-foreground"
    >
      <PendingBody message={message} text={queuedText(message)} />
      <div className="flex items-center justify-end gap-1 pr-1">
        {(uncertain || queue.canSteer) && (
          <IconButton
            icon={ArrowUpIcon}
            label={uncertain ? "Send again" : "Send now"}
            tip={uncertain ? description : "Send this message into the running turn"}
            size="sm"
            disabled={busy}
            onClick={() => {
              if ("saving" in message) return;
              return uncertain ? queue.resend(message) : queue.sendNow(message);
            }}
          />
        )}
        <IconButton
          icon={XIcon}
          label="Take back to composer"
          tip="Take back to composer, keeping your current draft"
          size="sm"
          disabled={busy}
          onClick={() => {
            if ("saving" in message) return;
            return queue.takeBack(message);
          }}
        />
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
