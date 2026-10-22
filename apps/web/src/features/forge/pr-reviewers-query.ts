import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
 * when the PR changes (`useFollowPrReviewers`) and after a dismissal (which may not change the
 * PR), never just because the window got focus.
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
 * other reader shares its answer. A change restarts a read already on its way, which may have
 * started before it. Opening the view reads again when the last read is older than the PR's.
 */
export function useFollowPrReviewers(workspaceId: string, detail: ForgePrDetail) {
  const query = usePrReviewers(workspaceId, detail);
  const { refetch, dataUpdatedAt } = query;
  const cache = useQueryClient();
  const changed = `${detail.updatedAt ?? ""}|${detail.reviewers.join(",")}|${detail.status.comments.length}`;
  const seen = useRef(changed);
  useEffect(() => {
    // The PR may have changed while no view followed it (another pane kept it fresh).
    const [read] = cache.getQueryCache().findAll({
      queryKey: ["forge", workspaceId],
      predicate: (q) => q.state.data === detail,
    });
    if (dataUpdatedAt && read && read.state.dataUpdatedAt > dataUpdatedAt) void refetch();
    // Only on opening: later changes are the effect below's.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (seen.current === changed) return;
    seen.current = changed;
    void refetch();
  }, [changed, refetch]);
  return query;
}

/**
 * Each reviewer's standing review by login. GitHub's reviewer read answers while it is current;
 * while it is being read again (the PR has changed) or after it failed, the PR's own review
 * comments answer, which are as fresh as the PR. The gates and the merge button read this.
 */
export function useReviewOutcomes(
  workspaceId: string,
  detail: ForgePrDetail,
): ReadonlyMap<string, ReviewOutcome> {
  const { data, isError, isFetching } = usePrReviewers(workspaceId, detail);
  const current = data && !isError && !isFetching ? data : undefined;
  const comments = detail.status.comments;
  return useMemo(
    () => (current ? reviewOutcomes(current) : reviewerOutcomes(comments)),
    [current, comments],
  );
}
