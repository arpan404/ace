import type { ForgePrDetail, ForgeRepository } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "./source.ts";

/** All provider-exposed PR commits, at most ten 25-commit pages. */
export function usePrCommits(props: {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
}) {
  const ref = props.detail.status.ref;
  return useDaemonQuery({
    queryKey: ["forge", props.workspaceId, ref, "workspace-commits", props.detail.status.headSha],
    retry: false,
    read: async (client, signal) => {
      const commits: import("@ace/protocol").ForgeCommit[] = [];
      let page: number | undefined = 1;
      let truncated = false;
      while (page !== undefined) {
        const result = await readForge(
          client,
          {
            op: "forge.pr.commits",
            workspaceId: props.workspaceId,
            repository: props.repository,
            number: ref.number,
            headSha: props.detail.status.headSha,
            page,
          },
          signal,
        );
        if (result.resource !== "prCommits") throw new Error("No commit response.");
        commits.push(...result.commits);
        truncated ||= result.truncated;
        page =
          result.nextPage && result.nextPage > page && result.nextPage <= 10
            ? result.nextPage
            : undefined;
      }
      return { commits, truncated };
    },
  });
}
