import type { ForgePrDetail, ForgeRepository } from "@ace/protocol";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { readForge } from "@/lib/forge-read.ts";
import { readCommitHistory, type CommitHistory } from "@ace/ui-core";
import { useHistoryQuery } from "./pr-history-query.ts";

/** Every commit of a PR, read newest page first, oldest first in the list. */
export function usePrCommits(props: {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
}) {
  const ref = props.detail.status.ref;
  return useHistoryQuery<CommitHistory>({
    queryKey: ["forge", props.workspaceId, ref, "workspace-commits", props.detail.status.headSha],
    gcTime: keptForgeMs,
    read: (client, signal, progress) =>
      readCommitHistory(async (before) => {
        const result = await readForge(
          client,
          {
            op: "forge.pr.commits",
            workspaceId: props.workspaceId,
            repository: props.repository,
            number: ref.number,
            headSha: props.detail.status.headSha,
            ...(before === undefined ? {} : { before }),
          },
          signal,
        );
        if (result.resource !== "prCommits") throw new Error("No commit response.");
        return result;
      }, progress),
  });
}
