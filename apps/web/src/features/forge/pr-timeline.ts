import type { ForgeComment } from "@ace/protocol";
import type { ForgeActivity, ForgeCommit, ForgePrDetail } from "@ace/protocol/forge-browser";

export type PrTimelineEntry =
  | { kind: "commit"; id: string; at: string | null; commit: ForgeCommit }
  | { kind: "comment"; id: string; at: string; comment: ForgeComment }
  | { kind: "event"; id: string; at: string | null; event: ForgeActivity };

/** Stable identities deduplicate REST timeline echoes of comments and commits. */
export function prTimeline(
  detail: ForgePrDetail,
  commits: readonly ForgeCommit[],
  events: readonly ForgeActivity[],
  order: "newest" | "oldest",
): PrTimelineEntry[] {
  const commentIds = new Set(detail.status.comments.map((c) => `${c.kind}:${c.id}`));
  const commitIds = new Set(commits.map((c) => c.sha));
  const rows: PrTimelineEntry[] = [
    ...commits.map((commit): PrTimelineEntry => ({
      kind: "commit",
      id: `commit:${commit.sha}`,
      at: commit.date,
      commit,
    })),
    ...detail.status.comments.map((comment): PrTimelineEntry => ({
      kind: "comment",
      id: `comment:${comment.kind}:${comment.id}`,
      at: comment.createdAt ?? comment.updatedAt,
      comment,
    })),
    ...events
      .filter(
        (event) =>
          !(
            (event.event === "commented" && commentIds.has(`issue:${event.id}`)) ||
            (event.event === "reviewed" && commentIds.has(`review:${event.id}`))
          ) && !(event.event === "committed" && event.commitSha && commitIds.has(event.commitSha)),
      )
      .map((event): PrTimelineEntry => ({
        kind: "event",
        id: `event:${event.event}:${event.id}`,
        at: event.at,
        event,
      })),
  ];
  if (detail.createdAt && !events.some((e) => e.event === "opened"))
    rows.push({
      kind: "event",
      id: "opened",
      at: detail.createdAt,
      event: {
        id: "opened",
        event: "opened",
        actor: detail.author,
        actorAvatarUrl: detail.authorAvatarUrl,
        at: detail.createdAt,
        raw: null,
      },
    });
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return unique.toSorted((a, b) => {
    const aTime = a.at ? Date.parse(a.at) : NaN;
    const bTime = b.at ? Date.parse(b.at) : NaN;
    // Undated provider events stay visible, following dated activity in either order.
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : a.id.localeCompare(b.id);
    if (!Number.isFinite(bTime)) return -1;
    return (order === "newest" ? bTime - aTime : aTime - bTime) || a.id.localeCompare(b.id);
  });
}
export function eventText(event: ForgeActivity): string {
  const titles: Record<string, string> = {
    opened: "Pull request opened",
    closed: "closed the pull request",
    reopened: "reopened the pull request",
    merged: "merged the pull request",
    reviewed: "submitted a review",
    labeled: "added label",
    unlabeled: "removed label",
    review_requested: "requested review from",
    review_request_removed: "removed review request for",
    head_ref_force_pushed: "force-pushed the branch",
    head_ref_deleted: "deleted the branch",
    ready_for_review: "marked ready for review",
    convert_to_draft: "converted to draft",
    renamed: "renamed the pull request",
    committed: "added a commit",
  };
  return `${titles[event.event] ?? event.event.replaceAll("_", " ")}${event.subject ? ` ${event.subject}` : ""}`;
}
