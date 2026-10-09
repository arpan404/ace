import { QueuedBubbles } from "./queued.tsx";
import { useQueuedPending } from "./queued-pending.ts";
import { useQueue } from "./use-queue.ts";

/** Pending messages follow the current output, distinct from the confirmed virtual feed. */
export function QueuedMessages(props: { threadId: string }) {
  const queue = useQueue(props.threadId);
  const pending = useQueuedPending(props.threadId, queue.page);
  return <QueuedBubbles queue={queue} pending={pending} />;
}
