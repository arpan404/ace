import type { LinkedPullRequest, ThreadDetails } from "@ace/protocol";

/**
 * How closely the background refresh follows a linked pull request. GitHub's hourly budget is
 * shared with everything else the person runs, so a PR is asked about only while it can change.
 *
 * - live: open, draft or never confirmed. Read every sweep the thread is due.
 * - closed: may be reopened. Read only when the thread's slow, settled cadence comes due.
 * - final: merged, or deleted on the forge. Never read again by the background refresh.
 */
export type PullRequestFollow = "live" | "closed" | "final";

export function pullRequestFollow(pr: LinkedPullRequest): PullRequestFollow {
  if (pr.unverified) return "live";
  if (pr.state === "merged" || pr.deleted) return "final";
  return pr.state === "closed" ? "closed" : "live";
}

/** Each linked PR's follow, falling back to the single-PR summary older threads carry. */
function follows(details: ThreadDetails | undefined): PullRequestFollow[] {
  if (details?.linkedPrs?.length) return details.linkedPrs.map(pullRequestFollow);
  const single = details?.linkedPr;
  if (!single) return [];
  return [single.state === "merged" ? "final" : single.state === "closed" ? "closed" : "live"];
}

/** A linked PR may change any minute, so the thread is never left at the settled cadence. */
export function followsLivePullRequest(details: ThreadDetails | undefined): boolean {
  return follows(details).includes("live");
}

/** Some linked PR can still change, so the thread stays in the refresh queue and is read. */
export function followsPullRequest(details: ThreadDetails | undefined): boolean {
  return follows(details).some((follow) => follow !== "final");
}
