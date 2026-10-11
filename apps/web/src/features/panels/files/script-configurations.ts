import { WorkspaceScript } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useCheckoutSource } from "./use-checkout.ts";

/** Detect supported root configurations even when they do not contain a script yet. */
export function useScriptConfigurations(threadId: string) {
  const source = useCheckoutSource();
  return useDaemonQuery({
    queryKey: ["checkout", "script-configurations", threadId],
    staleTime: 60_000,
    retry: false,
    read: async (_client, signal) => {
      const entries = await Promise.all(
        WorkspaceScript.shape.source.options.map(async (path) => {
          const stat = await source.stat(threadId, path, signal);
          return stat.version !== null && !stat.folder ? path : undefined;
        }),
      );
      return entries.filter((path) => path !== undefined);
    },
  });
}
