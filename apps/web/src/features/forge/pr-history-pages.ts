import type { ForgeActivity, ForgeCommit } from "@ace/protocol";

/** Timeline pages read at most: the first and the newest, 100 events each. */
export const activityPageLimit = 100;
/** Commit pages read at most, 100 commits each, newest first. */
export const commitPageLimit = 100;
/** Timeline pages read at once, so a long history loads in a few round trips. */
const parallelReads = 4;

/** What has been read of a history; `complete` once every page it will read has arrived. */
export type ActivityHistory = { events: ForgeActivity[]; truncated: boolean; complete: boolean };
export type CommitHistory = { commits: ForgeCommit[]; truncated: boolean; complete: boolean };
type ActivityPage = {
  events: ForgeActivity[];
  nextPage?: number | undefined;
  lastPage?: number | undefined;
  truncated: boolean;
};
type CommitPage = { commits: ForgeCommit[]; before?: string | undefined; truncated: boolean };

/**
 * Every timeline page. The first names the last, so the newest pages are read next, a few at
 * once, back toward the first. `onProgress` sees what has arrived so far, in page order. A
 * history longer than `activityPageLimit` pages keeps its first page and its newest ones.
 */
export async function readActivityHistory(
  read: (page: number) => Promise<ActivityPage>,
  onProgress: (history: ActivityHistory) => void,
): Promise<ActivityHistory> {
  const first = await read(1);
  const pages = new Map<number, ActivityPage>([[1, first]]);
  let skipped = false;
  const history = (complete: boolean): ActivityHistory => {
    const ordered = [...pages].toSorted(([a], [b]) => a - b).map(([, page]) => page);
    return {
      events: ordered.flatMap((page) => page.events),
      truncated: skipped || ordered.some((page) => page.truncated),
      complete,
    };
  };
  const last = first.lastPage;
  if (last === undefined) {
    // No last page named: follow the next links one by one.
    let previous = 1;
    let next = first.nextPage;
    while (next !== undefined && next > previous && pages.size < activityPageLimit) {
      onProgress(history(false));
      const page = await read(next);
      pages.set(next, page);
      previous = next;
      next = page.nextPage;
    }
    skipped = next !== undefined && next > previous;
    return history(true);
  }
  const oldest = Math.max(2, last - (activityPageLimit - 2));
  skipped = oldest > 2;
  const newestFirst = Array.from({ length: Math.max(0, last - oldest + 1) }, (_, i) => last - i);
  if (newestFirst.length) onProgress(history(false));
  await inParallel(newestFirst, parallelReads, async (number) => {
    pages.set(number, await read(number));
    onProgress(history(false));
  });
  return history(true);
}

/**
 * Every commit page, newest first, each found from the cursor of the one before it. The list
 * stays oldest first. `onProgress` sees the newest pages as they arrive.
 */
export async function readCommitHistory(
  read: (before: string | undefined) => Promise<CommitPage>,
  onProgress: (history: CommitHistory) => void,
): Promise<CommitHistory> {
  const pages: CommitPage[] = [];
  const history = (complete: boolean): CommitHistory => ({
    commits: pages.toReversed().flatMap((page) => page.commits),
    truncated: pages.some((page) => page.truncated) || pages.at(-1)?.before !== undefined,
    complete,
  });
  let before: string | undefined;
  do {
    if (pages.length) onProgress(history(false));
    const page = await read(before);
    pages.push(page);
    before = page.before;
  } while (before !== undefined && pages.length < commitPageLimit);
  return history(true);
}

/** Runs `run` on each item, at most `limit` at once; after a failure no new item starts. */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let failed = false;
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined && !failed; item = queue.shift()) {
      try {
        await run(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
}
