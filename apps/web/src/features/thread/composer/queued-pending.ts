import { usePendingSends } from "@ace/client-react";
import { CommandId, type QueuePage, type QueuedMessage } from "@ace/protocol";
import { useMemo } from "react";
import { useDismissedSends, useQueuedCommands } from "../items/pending-sends.ts";

/** A queued message this window sent that the queue page doesn't list yet. */
export type PendingQueued = Pick<QueuedMessage, "id" | "input" | "context" | "delivery"> & {
  /** Still being saved or sent: it can't be edited, moved or removed until the daemon has it. */
  saving: true;
};

/**
 * Queued messages on their way (UX audit SY-7): the pill shows the moment Enter is pressed,
 * from the outbox entry, before the daemon's queue is read again. The queue message id is the
 * command id, so the pill carries on under the same key once the page lists it.
 */
export function useQueuedPending(
  threadId: string,
  page: Pick<QueuePage, "messages"> | undefined,
): readonly PendingQueued[] {
  const pending = usePendingSends(threadId);
  const queued = useQueuedCommands(threadId);
  const dismissed = useDismissedSends();
  return useMemo(() => {
    const listed = new Set<string>(page?.messages.map((message) => message.id));
    return pending.flatMap((send): PendingQueued[] => {
      const payload = send.payload;
      if (payload.type !== "thread.send" || listed.has(send.commandId)) return [];
      if (!queued.has(send.commandId) || dismissed.has(send.commandId)) return [];
      return [
        {
          id: CommandId.parse(send.commandId),
          input: payload.input,
          context: payload.context,
          delivery: "queue",
          saving: true,
        },
      ];
    });
  }, [pending, page, queued, dismissed]);
}
