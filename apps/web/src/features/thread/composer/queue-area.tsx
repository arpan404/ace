import type { ThreadStatus } from "@ace/protocol";
import { QueueNotice } from "./queue-notice.tsx";
import { useQueue } from "./use-queue.ts";

/**
 * Above the composer: why the queue is held, with its way out. The bounded queue tray
 * sits directly on the input, below any attached cards.
 * Loads after the thread has painted, with the rest of the composer's parts.
 */
export function QueueArea(props: {
  threadId: string;
  status: ThreadStatus | undefined;
  onChooseModel(): void;
}) {
  const queue = useQueue(props.threadId);
  return (
    <QueueNotice
      threadId={props.threadId}
      status={props.status}
      queue={queue}
      onChooseModel={props.onChooseModel}
    />
  );
}
