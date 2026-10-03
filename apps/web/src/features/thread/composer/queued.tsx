import type { ThreadReader } from "@ace/client";
import { arrayEqual, useIntent, useThread } from "@ace/client-react";
import { ClockIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";

export interface QueuedMessage {
  intentId: string;
  text: string;
  /** How many times this text was already in the transcript when it was queued. */
  before: number;
}

const recent = 50;
function userTexts(reader: ThreadReader): string[] {
  const texts: string[] = [];
  for (const id of reader.order.slice(-recent)) {
    const item = reader.item(id);
    if (item?.type === "message" && item.role === "user")
      texts.push(item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
  }
  return texts;
}

/**
 * Messages sent while the agent was busy, shown as pills above the composer until the daemon
 * delivers them into the transcript.
 */
export function useQueue(threadId: string) {
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const delivered = useThread(threadId, ["order"], userTexts, arrayEqual);
  const count = useCallback(
    (text: string) => (delivered ?? []).filter((candidate) => candidate === text).length,
    [delivered],
  );
  // Delivered messages drop out as the transcript shows them; the list is pruned on change.
  const pending = queued.filter((message) => count(message.text) <= message.before);
  const add = useCallback(
    (message: { intentId: string; text: string }) =>
      setQueued((list) => [
        ...list.filter((queuedMessage) => count(queuedMessage.text) <= queuedMessage.before),
        { ...message, before: count(message.text) },
      ]),
    [count],
  );
  const remove = useCallback(
    (intentId: string) =>
      setQueued((list) => list.filter((message) => message.intentId !== intentId)),
    [],
  );
  return { queued: pending, add, remove };
}

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
