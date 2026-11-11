import type { ForgeCommit } from "@ace/protocol/forge-browser";
import type { PrTimelineItem } from "./forge-timeline.ts";

/** Commits one author added back to back, shown as one "pushed N commits" row. */
export type PrTimelinePush = {
  kind: "push";
  id: string;
  at: string | null;
  author: string;
  authorAvatarUrl?: string | undefined;
  /** Oldest first, in either timeline order, as they were pushed. */
  commits: ForgeCommit[];
};
export type PrConversationItem = Exclude<PrTimelineItem, { kind: "commit" }> | PrTimelinePush;

/**
 * Gathers each run of commits by one author into a push. A push is named after its first
 * commit, so it keeps its identity as more commits join it or the order flips.
 */
export function prTimelinePushes(
  items: readonly PrTimelineItem[],
  order: "newest" | "oldest",
): PrConversationItem[] {
  const out: PrConversationItem[] = [];
  let run: ForgeCommit[] = [];
  const flush = () => {
    // Newest-first lists hold each run newest first; the push still lists it oldest first.
    const commits = order === "newest" ? run.toReversed() : run;
    const first = commits[0];
    const last = commits.at(-1);
    if (first && last)
      out.push({
        kind: "push",
        id: `push:${first.sha}`,
        at: last.date,
        author: first.author,
        authorAvatarUrl: first.authorAvatarUrl,
        commits,
      });
    run = [];
  };
  for (const item of items) {
    if (item.kind !== "commit") {
      flush();
      out.push(item);
      continue;
    }
    if (run[0] && run[0].author !== item.commit.author) flush();
    run.push(item.commit);
  }
  flush();
  return out;
}
