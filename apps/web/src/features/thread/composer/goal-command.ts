import { useClient } from "@ace/client-react";
import { ThreadId, type GoalChange } from "@ace/protocol";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";

/**
 * Change the thread's native goal: set, pause or resume it, or "clear". Resolves true once the
 * daemon took it; a refusal is said in a toast and resolves false.
 */
export function useGoalCommand(threadId: string) {
  const client = useClient();
  const toast = useToast();
  return useCallback(
    async (change: GoalChange | "clear"): Promise<boolean> => {
      const id = ThreadId.parse(threadId);
      try {
        await runCommand(
          client,
          change === "clear"
            ? { type: "thread.goal.clear", threadId: id }
            : { type: "thread.goal.set", threadId: id, change },
        );
        return true;
      } catch (error) {
        toast.error({ title: "Couldn't change the goal", description: failureMessage(error) });
        return false;
      }
    },
    [client, toast, threadId],
  );
}
