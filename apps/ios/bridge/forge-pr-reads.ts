import type {
  ForgeActivity,
  ForgeCommit,
  ForgeLifecycleState,
  ForgePrDetail,
  ForgeRepository,
  ForgeReviewState,
} from "@ace/protocol";
import { commentsLockedFor } from "@ace/ui-core";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";

/*
 * The reads behind a pull request's Timeline and Code views. Each answers fresh from GitHub
 * (never from the list memory): a write's outcome is read, never assumed. The review state and
 * the lifecycle are niceties a page still shows without; the detail is not.
 */

export interface PrTarget {
  project: string;
  number: number;
  repository?: ForgeRepository | undefined;
}
export const scopeOf = (target: PrTarget) => ({
  workspaceId: target.project,
  ...(target.repository ? { repository: target.repository } : {}),
  number: target.number,
});

export async function prDetail(reads: ForgeReads, target: PrTarget): Promise<ForgePrDetail> {
  const value = await reads.read({ op: "forge.pr.detail", ...scopeOf(target) }, false);
  if (value.resource !== "prDetail") throw new ForgeRefusal("forge_invalid_data");
  return value.value;
}

export async function prReviewState(
  reads: ForgeReads,
  target: PrTarget,
): Promise<ForgeReviewState | undefined> {
  try {
    const value = await reads.read({ op: "forge.pr.review-state", ...scopeOf(target) }, false);
    return value.resource === "prReviewState" ? value.value : undefined;
  } catch {
    return undefined;
  }
}

export async function prLifecycle(
  reads: ForgeReads,
  target: PrTarget,
): Promise<ForgeLifecycleState | undefined> {
  try {
    const value = await reads.read({ op: "forge.pr.lifecycle", ...scopeOf(target) }, false);
    return value.resource === "prLifecycle" ? value.value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the conversation is locked to this account, by the lifecycle read. */
export const lockedOut = (lifecycle: ForgeLifecycleState | undefined) =>
  commentsLockedFor(lifecycle?.snapshot.conversation);

/**
 * The timeline's first page and, when there are more, its newest: the start and the latest of
 * a long pull request. `partial` says pages between were left out.
 */
export async function prActivity(
  reads: ForgeReads,
  target: PrTarget,
): Promise<{ events: ForgeActivity[]; partial: boolean }> {
  const page = async (number: number) => {
    const value = await reads.read(
      { op: "forge.pr.activity", ...scopeOf(target), page: number },
      false,
    );
    if (value.resource !== "prActivity") throw new ForgeRefusal("forge_invalid_data");
    return value;
  };
  try {
    const first = await page(1);
    const last = first.lastPage ?? first.nextPage;
    if (!last || last <= 1) return { events: first.events, partial: first.truncated };
    const newest = await page(last);
    return { events: [...first.events, ...newest.events], partial: last > 2 || newest.truncated };
  } catch {
    // The comments and reviews still show from the detail without the rest of the activity.
    return { events: [], partial: true };
  }
}

/** The newest page of commits, oldest first. */
export async function prCommits(
  reads: ForgeReads,
  target: PrTarget,
  headSha: string,
): Promise<{ commits: ForgeCommit[]; partial: boolean }> {
  try {
    const value = await reads.read({ op: "forge.pr.commits", ...scopeOf(target), headSha }, false);
    if (value.resource !== "prCommits") return { commits: [], partial: true };
    return { commits: value.commits, partial: value.before !== undefined || value.truncated };
  } catch {
    return { commits: [], partial: true };
  }
}
