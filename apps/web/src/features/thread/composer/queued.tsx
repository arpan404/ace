import { useIntent } from "@ace/client-react";
import { ClockIcon, XIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { QueuedMessage } from "@/lib/queued-messages.ts";

/** Messages sent while the agent was busy, as pills above the composer until delivered. */
export function QueuedPills(props: {
  queued: readonly QueuedMessage[];
  onRemove(message: QueuedMessage): void;
}) {
  if (!props.queued.length) return null;
  return (
    <ul aria-label="Queued messages" className="mb-2 flex flex-col items-center gap-1.5">
      {props.queued.map((message) => (
        <QueuedPill key={message.intentId} message={message} onRemove={props.onRemove} />
      ))}
    </ul>
  );
}

function QueuedPill(props: { message: QueuedMessage; onRemove(message: QueuedMessage): void }) {
  const intent = useIntent(props.message.intentId);
  const text = props.message.text;
  const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  const failed = intent?.state === "failed";
  return (
    <li className="fx-rise-in glass inline-flex h-7 max-w-full items-center gap-[7px] rounded-full pr-1.5 pl-2.5 text-sm text-muted-foreground">
      <ClockIcon aria-hidden size={14} />
      <span className={failed ? "text-status-failed" : undefined}>
        {failed ? "Not queued" : "Queued"}
      </span>
      <span className="min-w-0 truncate font-medium text-foreground">{short}</span>
      <IconButton
        icon={XIcon}
        label="Remove from queue"
        size="sm"
        className="size-5"
        onClick={() => props.onRemove(props.message)}
      />
    </li>
  );
}
