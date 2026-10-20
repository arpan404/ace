import type { Item, LinkedPullRequest } from "@ace/protocol";

/** The whole text an agent reported back through the call that started (or resumed) it. */
function reportText(spawn: Item | undefined): string | undefined {
  if (spawn?.type === "delegation.started") return spawn.outcome?.result ?? undefined;
  if (spawn?.type !== "tool_call") return undefined;
  return spawn.call.result?.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

const prUrl = /https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)/g;

/**
 * The thread's linked pull request an agent says it opened: the last PR URL in its report that
 * names one of `linked`. Mentions of other repositories' PRs, or of PRs the thread doesn't hold,
 * are not the agent's. Pure.
 */
export function agentPullRequest(
  reports: readonly (Item | undefined)[],
  linked: readonly LinkedPullRequest[],
): LinkedPullRequest | undefined {
  if (!linked.length) return undefined;
  let found: LinkedPullRequest | undefined;
  for (const report of reports) {
    const text = reportText(report);
    if (!text) continue;
    for (const match of text.matchAll(prUrl)) {
      const [, host, owner, name, number] = match;
      const pr = linked.find(
        (candidate) =>
          candidate.number === Number(number) &&
          candidate.repo.host.toLowerCase() === host?.toLowerCase() &&
          candidate.repo.owner.toLowerCase() === owner?.toLowerCase() &&
          candidate.repo.name.toLowerCase() === name?.toLowerCase(),
      );
      if (pr) found = pr;
    }
  }
  return found;
}

const stateOrder: Record<LinkedPullRequest["state"], number> = {
  open: 0,
  draft: 0,
  merged: 1,
  closed: 2,
};

/**
 * A thread's pull requests as the Summary lists them: the ones still in review first, then the
 * merged ones, then the closed ones, each newest first. Pure.
 */
export function summaryPullRequests(linked: readonly LinkedPullRequest[]): LinkedPullRequest[] {
  return linked
    .filter((pr) => !pr.deleted)
    .toSorted(
      (left, right) =>
        stateOrder[left.state] - stateOrder[right.state] || right.updatedAt - left.updatedAt,
    );
}
