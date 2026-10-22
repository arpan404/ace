/*
 * The transcript's scroll state machine. Pure: given what happened (the reader's gesture, a
 * scroll, a jump, a disclosure toggled) it says which mode the view is in, and given how the
 * rows moved it says how the view corrects. `use-feed-scroll.ts` is its I/O shell.
 *
 * - following: pinned to the live end; new content keeps the end in view, except while the
 *   reader is still moving up from it (`until`), so a slow scroll up is not pulled back.
 * - anchoring: code placed the view (a jump) or the reader opened or closed something: that row
 *   holds still, and following waits until the reader returns to the end themselves.
 * - free: the reader scrolled away; the row at the top of the view holds still while rows above
 *   it change.
 *
 * The reader's own gestures always win over code: one cancels a jump still landing.
 */

export type ScrollMode =
  | { kind: "following"; until?: number }
  | {
      kind: "anchoring";
      /** The row that holds still, and an item it shows to find it again under a new key. */
      key: string;
      itemId: string | undefined;
      /** A jump keeps re-aiming at its row until then (0: nothing to aim, a toggle). */
      aimUntil: number;
      align: "start" | "center";
    }
  | { kind: "free" };

export type ScrollEvent =
  /** A wheel, touch move, key or scrollbar drag, before the scroll it causes. */
  | { type: "gesture"; upward: boolean; atEnd: boolean; detached: boolean; at: number }
  /** A press on the view (a click, a touch starting): no direction, but the reader is there. */
  | { type: "press"; at: number }
  /** A scroll event, from any cause. `upward` is the reader's last direction. */
  | { type: "scrolled"; atEnd: boolean; upward: boolean; detached: boolean; gliding: boolean }
  | {
      type: "jump";
      key: string;
      itemId: string | undefined;
      align: "start" | "center";
      at: number;
    }
  | { type: "toggle"; key: string; itemId: string | undefined }
  | { type: "live" }
  | { type: "detached" };

export interface Transition {
  mode: ScrollMode;
  /** Stop a jump still re-aiming at its row: the reader took over. */
  cancelAim: boolean;
}

/** How long a jump keeps re-aiming while the rows around its target measure (the virtualizer's own limit). */
export const aimWindow = 5_000;
/** How long after an upward gesture at the end new content leaves the view where the reader put it. */
export const nudgeWindow = 300;

const following: ScrollMode = { kind: "following" };
const free: ScrollMode = { kind: "free" };

const aiming = (mode: ScrollMode, at: number) => mode.kind === "anchoring" && at < mode.aimUntil;

export function transition(mode: ScrollMode, event: ScrollEvent): Transition {
  switch (event.type) {
    case "gesture": {
      const cancelAim = aiming(mode, event.at);
      if (mode.kind === "following" && event.atEnd && !event.detached)
        return {
          mode: event.upward ? { kind: "following", until: event.at + nudgeWindow } : following,
          cancelAim,
        };
      if (!event.upward && event.atEnd && !event.detached) return { mode: following, cancelAim };
      if (mode.kind === "following" && !event.upward) return { mode, cancelAim };
      return { mode: free, cancelAim };
    }
    case "press":
      // The reader may be about to drag or select: a landing jump stops aiming, the row stays.
      return mode.kind === "anchoring" && aiming(mode, event.at)
        ? { mode: { ...mode, aimUntil: 0 }, cancelAim: true }
        : { mode, cancelAim: false };
    case "scrolled": {
      // Only the reader releases an anchored row; code scrolling it into place never does.
      if (mode.kind === "anchoring") return { mode, cancelAim: false };
      if (mode.kind === "following")
        return { mode: event.atEnd || event.gliding ? mode : free, cancelAim: false };
      const back = event.atEnd && !event.upward && !event.detached;
      return { mode: back ? following : mode, cancelAim: false };
    }
    case "jump":
      return {
        mode: {
          kind: "anchoring",
          key: event.key,
          itemId: event.itemId,
          aimUntil: event.at + aimWindow,
          align: event.align,
        },
        cancelAim: false,
      };
    case "toggle":
      return {
        mode: {
          kind: "anchoring",
          key: event.key,
          itemId: event.itemId,
          aimUntil: 0,
          align: "start",
        },
        cancelAim: false,
      };
    case "live":
      return { mode: following, cancelAim: false };
    case "detached":
      return { mode: mode.kind === "following" ? free : mode, cancelAim: false };
  }
}

/**
 * The row the view holds still, and how far its top sat below the view's top when last seen.
 * Relative to the view, not the list: a resize the virtualizer already answered by moving the
 * view leaves it unchanged, so no change is ever counted twice.
 */
export interface Held {
  key: string;
  itemId: string | undefined;
  top: number;
}

export type Correction =
  | { kind: "end" }
  | { kind: "shift"; by: number }
  /** A jump still landing: aim again at its row, which moved to `index`. */
  | { kind: "aim"; index: number; align: "start" | "center" }
  | { kind: "none" };

/**
 * How the view corrects after rows were added, removed or replaced. Following keeps the end in
 * view, once the reader stops moving up from it. Otherwise the view moves by however far the
 * held row drifted from where the reader saw it (`now.top`: its top below the view's top now, by
 * its measured position), so it sits there again (whatever sat at its index before), and a jump
 * still landing aims again at its row's new index rather than at whatever row now has the old one.
 */
export function correction(
  mode: ScrollMode,
  held: Held | undefined,
  now: { index: number; top: number } | undefined,
  at: number,
): Correction {
  if (mode.kind === "following") return at < (mode.until ?? 0) ? { kind: "none" } : { kind: "end" };
  if (!held || !now) return { kind: "none" };
  if (mode.kind === "anchoring" && aiming(mode, at))
    return { kind: "aim", index: now.index, align: mode.align };
  const by = now.top - held.top;
  return by === 0 ? { kind: "none" } : { kind: "shift", by };
}

/**
 * The row the view holds still: the anchored one, else the first row in view. Rows that just
 * landed above the held row measure over the next frames, and one not measured yet (or about to
 * shrink) can reach into view for a frame and pass for the first row in view; so while they
 * settle, the row already held (`settling`, given while it is still in view) stays held until
 * the reader moves the view.
 */
export function heldKey(
  mode: ScrollMode,
  top: { key: string; itemId: string | undefined } | undefined,
  settling?: { key: string; itemId: string | undefined } | undefined,
): { key: string; itemId: string | undefined } | undefined {
  if (mode.kind === "anchoring") return { key: mode.key, itemId: mode.itemId };
  if (mode.kind !== "free") return undefined;
  return settling ? { key: settling.key, itemId: settling.itemId } : top;
}

/**
 * A held row that left the transcript (a duplicate dropped once older history brought in the row
 * that says the same) hands its place to the nearest row that followed it and is still shown, so
 * rows landing above never lose the reader's place. `keys` are the rows before the change, `from`
 * the gone row's index among them; looks a few rows on at most.
 */
export function heldSuccessor<T>(
  keys: readonly string[],
  from: number,
  find: (key: string) => T | undefined,
  limit = 8,
): T | undefined {
  for (const key of keys.slice(from + 1, from + 1 + limit)) {
    const found = find(key);
    if (found) return found;
  }
  return undefined;
}

/** Where the held row is now, and whether older items just joined it at its top. */
export interface HeldRow {
  index: number;
  /**
   * Older history merged into this row above what the reader sees (its turn's earlier steps):
   * its next growth is above the reader, so the view moves with it.
   */
  grewAtTop?: boolean | undefined;
}

/**
 * Which row resizes the virtualizer compensates by moving the view, given where the held row is.
 * Following: none (the end is followed instead). Anchoring and free: every row above the held
 * one (the anchored row, or the first row in view), so it stays still while what is above it
 * measures; the held row itself grows downward without moving the view, so a reader inside a
 * long answer that is still streaming keeps their place, unless older items just joined it at
 * its top. Not knowing the held row yet (free, before the first look): the virtualizer's own
 * rule (rows starting above the fold).
 */
export function compensation(
  mode: ScrollMode,
  held: HeldRow | undefined,
): ((row: { index: number }) => boolean) | undefined {
  if (mode.kind === "following") return () => false;
  if (!held) return undefined;
  return (row) => row.index < held.index || (!!held.grewAtTop && row.index === held.index);
}

/**
 * Whether a row's items gained older ones above those it showed before (`before`, `after`: its
 * items, oldest first): older history joined its turn at the top.
 */
export function joinedAtTop(before: readonly string[], after: readonly string[]): boolean {
  const first = before[0];
  return first !== undefined && after[0] !== first && after.includes(first);
}
