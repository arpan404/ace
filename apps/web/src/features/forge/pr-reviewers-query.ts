import { useEffect, useRef } from "react";
import type { ForgePrDetail, ForgePrReviewers } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { keptForgeMs } from "@/lib/query-persistence.ts";

/**
 * The PR's reviewers as GitHub has them now: who is asked, each one's latest review, GitHub's
 * suggestions and what this account may change. Read again whenever the PR itself changes.
 */
export function usePrReviewers(workspaceId: string, detail: ForgePrDetail) {
  const pr = detail.status.ref;
  const query = useDaemonQuery<ForgePrReviewers>({
    queryKey: ["forge", workspaceId, pr, "reviewers"],
    retry: false,
    gcTime: keptForgeMs,
    refetchOnReconnect: "always",
    staleTime: 0,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        { op: "forge.pr.reviewers", workspaceId, repository: pr.repository, number: pr.number },
        signal,
      );
      if (result.resource !== "prReviewers") throw new Error("No reviewers.");
      return result.value;
    },
  });
  const { refetch } = query;
  // A new review or request shows in the PR first; its reviewers follow.
  const changed = `${detail.updatedAt ?? ""}|${detail.reviewers.join(",")}|${detail.status.comments.length}`;
  const seen = useRef(changed);
  useEffect(() => {
    if (seen.current === changed) return;
    seen.current = changed;
    void refetch();
  }, [changed, refetch]);
  return query;
}
