import type { ForgeActivity, ForgePrDetail } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "./source.ts";

/**
 * Every activity event of a pull request (up to 120 pages), read once and shared by the
 * Timeline and the merge gates (who merged it, whether its branch was deleted).
 */
export function usePrActivityEvents(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  enabled?: boolean;
}) {
  const ref = props.detail.status.ref;
  return useDaemonQuery({
    queryKey: [
      "forge",
      props.workspaceId,
      ref,
      "workspace-activity",
      props.detail.updatedAt,
      props.detail.status.headSha,
    ],
    enabled: props.enabled ?? true,
    retry: false,
    read: async (client, signal) => {
      const events: ForgeActivity[] = [];
      let page: number | undefined = 1;
      let truncated = false;
      while (page !== undefined) {
        const result = await readForge(
          client,
          {
            op: "forge.pr.activity",
            workspaceId: props.workspaceId,
            repository: ref.repository,
            number: ref.number,
            page,
          },
          signal,
        );
        if (result.resource !== "prActivity") throw new Error("No activity response.");
        events.push(...result.events);
        truncated ||= result.truncated;
        page =
          result.nextPage && result.nextPage > page && result.nextPage <= 120
            ? result.nextPage
            : undefined;
      }
      return { events, truncated };
    },
  });
}
