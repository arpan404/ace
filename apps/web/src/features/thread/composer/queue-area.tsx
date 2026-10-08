import type { ThreadStatus } from "@ace/protocol";
import { QueueNotice } from "./queue-notice.tsx";
import { QueuedPills } from "./queued.tsx";
import { useQueuedPending } from "./queued-pending.ts";
import { useQueue } from "./use-queue.ts";

/**
 * Above the composer: why the queue is held (with its way out), then the messages waiting in it
 * as pills, including ones just sent that the daemon's queue doesn't list yet (UX audit SY-7).
 * Loads after the thread has painted, with the rest of the composer's parts.
 */
export function QueueArea(props: {
  threadId: string;
  status: ThreadStatus | undefined;
  onChooseModel(): void;
}) {
  const queue = useQueue(props.threadId);
  const pending = useQueuedPending(props.threadId, queue.page);
  return (
    <>
      <QueueNotice
        threadId={props.threadId}
        status={props.status}
        queue={queue}
        onChooseModel={props.onChooseModel}
      />
      {(queue.messages.length > 0 || pending.length > 0) && (
        <QueuedPills queue={queue} pending={pending} />
      )}
    </>
  );
}
