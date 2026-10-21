import type { ForgePrDetail } from "@ace/protocol";
import { readForge } from "@/lib/forge-read.ts";
import { readActivityHistory, type ActivityHistory } from "./pr-history-pages.ts";
import { useHistoryQuery } from "./pr-history-query.ts";

/**
 * Every activity event of a pull request, read once and shared by the Timeline and the merge
 * gates (who merged it, whether its branch was deleted). The newest pages arrive first.
 */
export function usePrActivityEvents(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  enabled?: boolean;
}) {
  const ref = props.detail.status.ref;
  return useHistoryQuery<ActivityHistory>({
    queryKey: [
      "forge",
      props.workspaceId,
      ref,
      "workspace-activity",
      props.detail.updatedAt,
      props.detail.status.headSha,
    ],
    enabled: props.enabled ?? true,
    read: (client, signal, progress) =>
      readActivityHistory(async (page) => {
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
        return result;
      }, progress),
  });
}
