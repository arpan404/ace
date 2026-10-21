import { ThreadId, type ForgePrRef } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { readForge } from "./source.ts";

/**
 * The native stack a PR belongs to, as GitHub and the task's checkout see it. The Summary's
 * rail and the stack's actions read the same query, so they never disagree.
 */
export function usePrStackQuery(props: { workspaceId: string; pr: ForgePrRef; threadId: string }) {
  const ref = props.pr;
  return useDaemonQuery({
    queryKey: ["forge", props.workspaceId, ref, "stack", props.threadId],
    retry: false,
    gcTime: keptForgeMs,
    staleTime: 0,
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        {
          op: "forge.pr.stack",
          workspaceId: props.workspaceId,
          repository: ref.repository,
          number: ref.number,
          threadId: props.threadId ? ThreadId.parse(props.threadId) : undefined,
        },
        signal,
      );
      if (result.resource !== "prStack") throw new Error("No stack returned.");
      return result.value;
    },
  });
}
