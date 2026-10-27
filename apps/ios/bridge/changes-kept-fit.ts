import { storedViewed, type ReviewDraft, type ViewedFiles } from "@ace/ui-core/review";
import { utf8Bytes } from "./kept-read.ts";

/*
 * What of the Changes sheet's state fits in its kept value (the host caps one at 1 MiB). Viewed
 * marks have their own budget and give way oldest first; drafts still to send or still open are
 * never dropped to make room for marks. Pure.
 */

/** Bytes one kept value may take: under the host's 1 MiB with room for its own framing. */
export const keptBudget = 1_000_000;
/** Bytes viewed marks may take at most. */
export const marksBudget = 128 * 1024;
/** Resolved drafts kept, newest first, as the web keeps drafts. */
export const maxDrafts = 400;
/** `{"v":1,"drafts":[],"viewed":[],"layout":"unified"}` and then some. */
const envelope = 256;

export type StoredMarks = ReturnType<typeof storedViewed>;

export type Fitted =
  | { ok: true; drafts: ReviewDraft[]; viewed: StoredMarks }
  | { ok: false; reason: string };

const bytes = (value: unknown) => utf8Bytes(JSON.stringify(value));

/** The newest marks that fit in `budget` bytes: the oldest files of the oldest threads go first. */
export function fitMarks(
  marks: StoredMarks,
  budget: number,
): { viewed: StoredMarks; size: number } {
  let size = 2;
  const kept: StoredMarks = [];
  for (let thread = marks.length - 1; thread >= 0; thread--) {
    const [id, files] = marks[thread] ?? ["", []];
    const head = bytes(id) + 6;
    if (size + head > budget) break;
    size += head;
    const held: [string, string][] = [];
    for (let file = files.length - 1; file >= 0; file--) {
      const entry = files[file];
      if (!entry) continue;
      const cost = bytes(entry) + 1;
      if (size + cost > budget) break;
      size += cost;
      held.push(entry);
    }
    if (!held.length) {
      size -= head;
      break;
    }
    kept.push([id, held.toReversed()]);
    if (held.length < files.length) break;
  }
  return { viewed: kept.toReversed(), size };
}

const byNewest = (a: ReviewDraft, b: ReviewDraft) => b.createdAt - a.createdAt;

/**
 * Drafts and marks for the kept value. Unsent and open drafts are all kept; when they don't fit
 * even without marks nothing is saved (the last saved value stays) and `reason` says why.
 */
export function fitKept(drafts: readonly ReviewDraft[], viewed: ViewedFiles): Fitted {
  const live = drafts.filter((draft) => draft.state !== "resolved").toSorted(byNewest);
  const resolved = drafts.filter((draft) => draft.state === "resolved").toSorted(byNewest);
  const liveSize = live.reduce((sum, draft) => sum + bytes(draft) + 1, 0);
  const room = keptBudget - envelope - liveSize;
  if (room < 2)
    return {
      ok: false,
      reason:
        "Unsent comments are too large to keep on this phone: send or discard some, or they go when ace closes.",
    };
  const marks = fitMarks(storedViewed(viewed), Math.min(marksBudget, room));
  let left = room - marks.size;
  const kept = [...live];
  for (const draft of resolved) {
    if (kept.length >= Math.max(maxDrafts, live.length)) break;
    const cost = bytes(draft) + 1;
    if (cost > left) continue;
    left -= cost;
    kept.push(draft);
  }
  return { ok: true, drafts: kept.toSorted(byNewest), viewed: marks.viewed };
}
