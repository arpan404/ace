import type { ForgeActivity, ForgeCommit } from "@ace/protocol";

/** Timeline pages read at most: the first and the newest, 100 events each. */
export const activityPageLimit = 100;
/** Commit pages read at most each way (one after another, side by side), 100 commits each. */
export const commitPageLimit = 100;
/** Pages read at once, so a long history loads in a few round trips. */
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
type CommitPage = {
  commits: ForgeCommit[];
  before?: string | undefined;
  alongside?: string[] | undefined;
  truncated: boolean;
};

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
  await together(
    pool(newestFirst, parallelReads, async (number) => {
      pages.set(number, await read(number));
      onProgress(history(false));
    }),
  );
  return history(true);
}

/**
 * Every commit page, newest first. Each listed page names the next older one, so those are
 * read one after another; the newest page may also name older pages that stand on their own,
 * read side by side with them. The list stays oldest first. `onProgress` sees the pages as
 * they arrive, the newest first.
 */
export async function readCommitHistory(
  read: (before: string | undefined) => Promise<CommitPage>,
  onProgress: (history: CommitHistory) => void,
): Promise<CommitHistory> {
  const newest = await read(undefined);
  const listed: CommitPage[] = [newest];
  const named = newest.alongside ?? [];
  const older = named.slice(0, commitPageLimit);
  const olderPages = new Map<number, CommitPage>();
  let cut = older.length < named.length;
  const history = (complete: boolean): CommitHistory => {
    const pages = [
      ...older.flatMap((_, i) => olderPages.get(i) ?? []).toReversed(),
      ...listed.toReversed(),
    ];
    return {
      commits: pages.flatMap((page) => page.commits),
      truncated: cut || pages.some((page) => page.truncated),
      complete,
    };
  };
  if (newest.before === undefined && !older.length) return history(true);
  onProgress(history(false));
  const walk = async (stopped: () => boolean) => {
    for (let before = newest.before; before !== undefined && !stopped();) {
      if (listed.length >= commitPageLimit) {
        cut = true;
        return;
      }
      const page = await read(before);
      listed.push(page);
      onProgress(history(false));
      before = page.before;
    }
  };
  const indexes = older.map((_, i) => i);
  await together([
    walk,
    ...pool(indexes, parallelReads - 1, async (i) => {
      const cursor = older[i];
      if (cursor === undefined) return;
      olderPages.set(i, await read(cursor));
      onProgress(history(false));
    }),
  ]);
  return history(true);
}

type Worker = (stopped: () => boolean) => Promise<void>;

/** Runs `workers` side by side; once one fails, none starts another read, and it throws. */
async function together(workers: readonly Worker[]): Promise<void> {
  let failed = false;
  const settled = await Promise.allSettled(
    workers.map(async (work) => {
      try {
        await work(() => failed);
      } catch (error) {
        failed = true;
        throw error;
      }
    }),
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

/** `limit` workers taking `items` from one queue. */
function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Worker[] {
  const queue = [...items];
  return Array.from({ length: Math.min(limit, items.length) }, () => async (stopped) => {
    for (let item = queue.shift(); item !== undefined && !stopped(); item = queue.shift())
      await run(item);
  });
}
