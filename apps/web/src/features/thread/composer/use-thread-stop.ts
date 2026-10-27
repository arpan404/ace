import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { useEffect } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { clearStop, recordStop, useStopFence, useStopping } from "./stop-state.ts";

/**
 * Stop for a thread's agent tree, as the composer's button sends it: a durable
 * `thread.interrupt` naming the turn it was pressed in, read as "Stopping…" until that turn
 * ends. `busy` is whether anything still runs; once nothing does, the Stop is forgotten.
 */
export function useThreadStop(threadId: string, busy: boolean) {
  const client = useClient();
  const toast = useToast();
  const fence = useStopFence(threadId);
  const run = fence && "runId" in fence ? fence.runId : undefined;
  const stopping = useStopping(threadId);
  const stop = () => {
    if (!fence) return;
    const commandId = crypto.randomUUID();
    recordStop(threadId, { commandId, runId: run });
    void client
      .enqueue(
        { type: "thread.interrupt", threadId: ThreadId.parse(threadId), cascade: true, ...fence },
        commandId,
      )
      .catch(() => {
        clearStop(threadId);
        toast.error({ title: "Couldn't stop the agent" });
      });
  };
  useEffect(() => {
    if (!busy) clearStop(threadId);
  }, [busy, threadId]);
  return { stop, stopping };
}
