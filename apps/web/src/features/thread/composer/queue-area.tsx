import type { ThreadStatus } from "@ace/protocol";
import { QueueNotice } from "./queue-notice.tsx";
import { useQueue } from "./use-queue.ts";

/**
 * Above the composer: why the queue is held, with its way out. Pending messages themselves
 * live at the transcript's tail so a long queue never covers the input or its attached cards.
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
