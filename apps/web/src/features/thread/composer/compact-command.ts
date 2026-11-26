import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";

/**
 * Ask the provider to compact this thread's context with its own compactor. Resolves true once
 * the daemon took it; a refusal is said in a toast and resolves false.
 */
export function useCompactCommand(threadId: string) {
  const client = useClient();
  const toast = useToast();
  return useCallback(async (): Promise<boolean> => {
    try {
      await runCommand(client, { type: "thread.compact", threadId: ThreadId.parse(threadId) });
      return true;
    } catch (error) {
      toast.error({ title: "Couldn't compact the context", description: failureMessage(error) });
      return false;
    }
  }, [client, toast, threadId]);
}
