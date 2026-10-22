import { useEffect, useMemo, useRef } from "react";
import type { ForgePrDetail, ForgePrReviewers } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readForge } from "@/lib/forge-read.ts";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { reviewOutcomes } from "./pr-reviewers-model.ts";
import { reviewerOutcomes, type ReviewOutcome } from "./pr-summary-model.ts";

/** How long a reviewers read stands before a new reader asks GitHub again. */
const reviewersFreshMs = 30_000;

/**
 * The PR's reviewers as GitHub has them: who is asked, each one's standing review, GitHub's
 * suggestions and what this account may change. Every reader shares one read; it is read again
 * after a write (by the writer) and when the PR changes (`useFollowPrReviewers`), never just
 * because the window got focus.
 */
export function usePrReviewers(workspaceId: string, detail: ForgePrDetail) {
  const pr = detail.status.ref;
  return useDaemonQuery<ForgePrReviewers>({
    queryKey: ["forge", workspaceId, pr, "reviewers"],
    retry: false,
    gcTime: keptForgeMs,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    staleTime: reviewersFreshMs,
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
}

/**
 * The reviewers, read again whenever the PR itself changes: a new review or request shows in
 * the PR first. Only the PR view, mounted whichever tab shows, follows (`usePrActions`); every
 * other reader shares its answer. A read already on its way is joined, never cancelled.
 */
export function useFollowPrReviewers(workspaceId: string, detail: ForgePrDetail) {
  const query = usePrReviewers(workspaceId, detail);
  const { refetch } = query;
  const changed = `${detail.updatedAt ?? ""}|${detail.reviewers.join(",")}|${detail.status.comments.length}`;
  const seen = useRef(changed);
  useEffect(() => {
    if (seen.current === changed) return;
    seen.current = changed;
    void refetch({ cancelRefetch: false });
  }, [changed, refetch]);
  return query;
}

/**
 * Each reviewer's standing review by login: from GitHub's reviewer read once it has answered,
 * else from the PR's review comments. The gates and the Reviewers list read this one source.
 */
export function useReviewOutcomes(
  workspaceId: string,
  detail: ForgePrDetail,
): ReadonlyMap<string, ReviewOutcome> {
  const { data } = usePrReviewers(workspaceId, detail);
  const comments = detail.status.comments;
  return useMemo(
    () => (data ? reviewOutcomes(data) : reviewerOutcomes(comments)),
    [data, comments],
  );
}
