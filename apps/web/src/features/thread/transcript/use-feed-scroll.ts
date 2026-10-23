import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { scrollToEnd as glideToEnd } from "@/lib/motion.ts";
import { blockItems } from "./blocks.ts";
import { rowOf, type Row } from "./rows.ts";
import { listenScrollIntent } from "./scroll-intent.ts";
import {
  compensation,
  correction,
  handOver,
  heldKey,
  heldSuccessor,
  joinedAtTop,
  transition,
  type Held,
  type ScrollEvent,
  type ScrollMode,
} from "./scroll-mode.ts";
import { useDockShift, useStayPinned } from "./scroll.ts";
import { useLayout, type SessionKey } from "@/lib/layout.tsx";
import {
  createScrollMemory,
  restoreAt,
  type SavedScroll,
  type ScrollMemory,
} from "./scroll-memory.ts";

/*
 * The I/O shell of the transcript's scroll state machine (`scroll-mode.ts`): it feeds the machine
 * the reader's gestures, scroll events, jumps and disclosure toggles, and carries out what it
 * decides through the virtualizer, so the virtualizer always knows where the view is.
 */

/** How close to the end still counts as at the end. */
const nearEdge = 64;
/** A disclosure in a row: what opening or closing it changes is that row's own height. */
const disclosure = "button[aria-expanded]:not([aria-haspopup])";

/** The first row in view, and how far its top sits from the viewport's. */
export interface TopRow {
  index: number;
  offset: number;
}

type FeedVirtualizer = Virtualizer<HTMLDivElement, Element>;

export interface FeedScrollOptions {
  viewport: RefObject<HTMLDivElement | null>;
  virtualizer: FeedVirtualizer;
  rows: readonly Row[];
  /** The rows' keys; the same array while they are the same keys. */
  keys: readonly string[];
  total: number;
  detached: boolean;
  hasOlder: boolean;
  /** Room kept above the first row in view (the search bar floats there). */
  topRoom: number;
  dock: RefObject<HTMLElement | null>;
  now(): number;
  /** The reader scrolled up or down by a gesture, for paging history. */
  onDirection(upward: boolean): void;
  /** Where the reader was when they last left this thread: reopened there if nothing is new. */
  restore: SavedScroll | undefined;
  /** Keeps where the reader is as the feed goes (undefined: at the live end). */
  remember(saved: SavedScroll | undefined): void;
}

const threadScrollsKey: SessionKey<ScrollMemory> = { name: "thread scrolls" };

/** Reading positions of the threads left in this app's session. */
export function useThreadScrolls(): ScrollMemory {
  return useLayout().sessionValue(threadScrollsKey, createScrollMemory);
}

const distanceToEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

/**
 * How the virtualizer scrolls the viewport: an instant scroll is a plain `scrollTop` write, so
 * it lands at once wherever `scrollTo` does nothing; a smooth one glides.
 */
export function writeScroll(
  offset: number,
  options: { adjustments?: number | undefined; behavior?: ScrollBehavior | undefined },
  instance: FeedVirtualizer,
): void {
  const el = instance.scrollElement;
  if (!el) return;
  const top = offset + (options.adjustments ?? 0);
  if (options.behavior === "smooth") el.scrollTo({ top, behavior: "smooth" });
  else el.scrollTop = top;
}

/**
 * The virtualizer learns a new position from the scroll event, which arrives after the rows it
 * just mounted measured themselves; until then it corrects their size changes against the old
 * position. Telling it at once keeps a placement where it landed.
 */
function synced(virtualizer: FeedVirtualizer, el: HTMLElement): void {
  virtualizer.scrollOffset = el.scrollTop;
}

/** Scrolls through the virtualizer, synced at once, so its range follows even with no event. */
function placeAt(virtualizer: FeedVirtualizer, el: HTMLElement, offset: number): void {
  virtualizer.scrollToOffset(offset);
  synced(virtualizer, el);
}

/**
 * Where row `index` is by the sizes measured so far. Rows measure as React attaches them, before
 * this hook's layout effects run, but the virtualizer's cached positions catch up only on its
 * next read of them: asking for its total size first brings them up to date.
 */
function placed(virtualizer: FeedVirtualizer, index: number) {
  virtualizer.getTotalSize();
  return virtualizer.measurementsCache[index];
}

function toEndOf(virtualizer: FeedVirtualizer, el: HTMLElement): void {
  const end = el.scrollHeight - el.clientHeight;
  if (Math.abs(el.scrollTop - end) >= 1) placeAt(virtualizer, el, end);
}

function aimAt(
  virtualizer: FeedVirtualizer,
  el: HTMLElement,
  index: number,
  align: "start" | "center",
): void {
  virtualizer.scrollToIndex(index, { align });
  synced(virtualizer, el);
}

function compensateBy(
  virtualizer: FeedVirtualizer,
  rule: ((row: { index: number }) => boolean) | undefined,
  grewAtTop: RefObject<string | undefined>,
): void {
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    rule &&
    ((item) => {
      const adjust = rule(item);
      // That growth is in: from the next look on, the row grows downward like any other.
      if (adjust && item.key === grewAtTop.current) grewAtTop.current = undefined;
      return adjust;
    });
}

export function useFeedScroll(options: FeedScrollOptions) {
  const { viewport, dock, virtualizer, rows, keys, total, detached, hasOlder, now, onDirection } =
    options;
  const mode = useRef<ScrollMode>(detached ? { kind: "free" } : { kind: "following" });
  const [following, setFollowing] = useState(!detached);
  const held = useRef<Held | undefined>(undefined);
  const top = useRef<TopRow | undefined>(undefined);
  const upward = useRef(false);
  const glidingUntil = useRef(0);
  // Each row's index by key: finding a held row costs the same in a thread of any length.
  const indexOf = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);

  /** Where a row is now, by key, else by an item it shows (its key may have changed). */
  const locate = useCallback(
    (key: string, itemId: string | undefined) => {
      let index = indexOf.get(key) ?? -1;
      if (index < 0 && itemId !== undefined) index = rowOf(rows, itemId);
      const item = index < 0 ? undefined : placed(virtualizer, index);
      return item && { index, start: item.start, end: item.end, key: keys[index] ?? key };
    },
    [indexOf, keys, rows, virtualizer],
  );
  // The held row older history just joined at its top: its next growth is above the reader.
  const grewAtTop = useRef<string | undefined>(undefined);
  // Rows just landed above the held row and are still measuring: it stays held until the reader
  // moves the view again.
  const settling = useRef(false);
  /** Which resizes the virtualizer answers by moving the view, for the current mode. */
  const compensate = useCallback(() => {
    const was = mode.current.kind === "following" ? undefined : held.current;
    const at = was && locate(was.key, was.itemId);
    const rule = compensation(
      mode.current,
      at && { index: at.index, grewAtTop: grewAtTop.current === at.key },
    );
    compensateBy(virtualizer, rule, grewAtTop);
  }, [locate, virtualizer]);
  const apply = useCallback(
    (event: ScrollEvent, el: HTMLElement | null) => {
      const step = transition(mode.current, event);
      mode.current = step.mode;
      // Overriding the jump's index target with where the view is now stops its re-aiming.
      if (step.cancelAim && el) placeAt(virtualizer, el, el.scrollTop);
      setFollowing(step.mode.kind === "following");
      compensate();
    },
    [virtualizer, compensate],
  );
  const hold = useCallback(
    (el: HTMLElement, index: number, itemId?: string) => {
      const row = rows[index];
      const start = placed(virtualizer, index)?.start;
      if (!row) return undefined;
      const id = itemId ?? blockItems(row.block)[0];
      if (start !== undefined)
        held.current = { key: row.key, itemId: id, top: start - el.scrollTop };
      return { key: row.key, itemId: id };
    },
    [rows, virtualizer],
  );

  /**
   * Reads the first row in view and refreshes where the held row is, so the next correction
   * counts only what changed since. Runs on every gesture and scroll, not just once a frame:
   * rows that land between a scroll and the next frame (older history arriving as the reader
   * leaves the end) must be corrected against where the reader is now, never against a stale
   * place or no held row at all.
   */
  const look = useCallback(
    (el: HTMLElement): VirtualItem | undefined => {
      const fold = el.scrollTop + options.topRoom;
      const first = virtualizer.getVirtualItems().find((item) => item.end > fold);
      if (!first) return undefined;
      top.current = { index: first.index, offset: first.start - el.scrollTop };
      const row = rows[first.index];
      const shown = row && { key: row.key, itemId: blockItems(row.block)[0] };
      const was = held.current;
      const still = settling.current && was ? locate(was.key, was.itemId) : undefined;
      const inView =
        !!still && still.end > el.scrollTop && still.start < el.scrollTop + el.clientHeight;
      const which = heldKey(mode.current, shown, inView ? was : undefined);
      const at = which && locate(which.key, which.itemId);
      held.current =
        which && at ? { ...which, key: at.key, top: at.start - el.scrollTop } : undefined;
      // The rows above this one are what the virtualizer compensates for, as the reader moves.
      compensate();
      return first;
    },
    [options.topRoom, virtualizer, rows, locate, compensate],
  );
  const latestLook = useRef(look);
  useLayoutEffect(() => {
    latestLook.current = look;
  });

  // The reader's gestures, before the scrolls they cause.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    return listenScrollIntent(
      el,
      (up) => {
        settling.current = false;
        upward.current = up;
        if (up) glidingUntil.current = 0;
        onDirection(up);
        const atEnd = distanceToEnd(el) < nearEdge;
        apply(
          {
            type: "gesture",
            upward: up,
            atEnd,
            scrollable: el.scrollHeight > el.clientHeight,
            hasOlder,
            detached,
            at: now(),
          },
          el,
        );
        // Leaving the end holds the row in view at once, before any rows can land.
        latestLook.current(el);
      },
      () => {
        settling.current = false;
        apply({ type: "press", at: now() }, el);
      },
    );
  }, [viewport, apply, detached, hasOlder, now, onDirection]);

  // Opening or closing a disclosure holds its row still: what changes is below its toggle.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const click = (event: MouseEvent) => {
      const toggle = event.target instanceof Element ? event.target.closest(disclosure) : null;
      const row = toggle?.closest<HTMLElement>("[data-index]");
      if (!row || !el.contains(row)) return;
      const which = hold(el, Number(row.dataset.index));
      if (which) apply({ type: "toggle", ...which }, el);
    };
    el.addEventListener("click", click, true);
    return () => el.removeEventListener("click", click, true);
  }, [viewport, hold, apply]);

  useEffect(() => {
    if (detached) apply({ type: "detached" }, viewport.current);
  }, [detached, apply, viewport]);

  // Back in a thread with nothing new since: the row the reader left on, where it was, held
  // still while the rows around it measure (until the reader scrolls). Once, when rows exist.
  const restoring = useRef(detached ? undefined : options.restore);
  useLayoutEffect(() => {
    const el = viewport.current;
    const saved = restoring.current;
    if (!el || !saved || !keys.length) return;
    restoring.current = undefined;
    const at = restoreAt(saved, keys);
    const row = at && rows[at.index];
    const start = at && placed(virtualizer, at.index)?.start;
    if (!at || !row || start === undefined || mode.current.kind !== "following") return;
    apply({ type: "toggle", key: row.key, itemId: blockItems(row.block)[0] }, el);
    placeAt(virtualizer, el, start - at.offset);
    hold(el, at.index);
    compensate();
  }, [keys, rows, viewport, virtualizer, apply, hold, compensate]);

  // Leaving the thread keeps where the reader was, unless they were at the live end.
  const leaving = useRef({ rows, detached, remember: options.remember });
  useLayoutEffect(() => {
    leaving.current = { rows, detached, remember: options.remember };
  });
  useEffect(
    () => () => {
      const { rows: shown, detached: away, remember } = leaving.current;
      const at = top.current;
      const row = at && shown[at.index];
      if (away || mode.current.kind === "following" || !at || !row) return remember(undefined);
      remember({
        key: row.key,
        offset: at.offset,
        lastKey: shown.at(-1)?.key,
        measured: Array.from(virtualizer.measurementsCache, (item) => ({ ...item })),
      });
    },
    [virtualizer],
  );

  // Rows changed: follow the end, or hold the held row where it was. Resizes are the
  // virtualizer's to compensate (by `compensate`'s rule); only added, removed or replaced rows
  // are corrected here, so no growth is counted twice.
  const previous = useRef({ keys, total, rows, indexOf });
  useLayoutEffect(() => {
    const before = previous.current;
    const structural = before.keys !== keys;
    const grew = before.total !== total;
    previous.current = { keys, total, rows, indexOf };
    const el = viewport.current;
    if (!el || (mode.current.kind === "following" ? !structural && !grew : !structural)) return;
    const was = held.current;
    let at = was && locate(was.key, was.itemId);
    // The held row left the transcript: the row that followed it takes its place.
    const from = was && !at && structural ? before.indexOf.get(was.key) : undefined;
    const succeeded = from !== undefined;
    if (succeeded) at = heldSuccessor(before.keys, from, (key) => locate(key, undefined));
    const fix = correction(
      mode.current,
      was,
      at && { index: at.index, top: at.start - el.scrollTop },
      now(),
    );
    if (fix.kind === "end") toEndOf(virtualizer, el);
    else if (fix.kind === "shift") placeAt(virtualizer, el, el.scrollTop + fix.by);
    else if (fix.kind === "aim") aimAt(virtualizer, el, fix.index, fix.align);
    if (was && at) {
      const row = rows[at.index];
      const itemId = succeeded && row ? blockItems(row.block)[0] : was.itemId;
      held.current = { ...was, key: at.key, itemId, top: at.start - el.scrollTop };
      if (succeeded) mode.current = handOver(mode.current, { key: at.key, itemId });
      settling.current = structural && mode.current.kind === "free";
      const earlier = before.rows[before.indexOf.get(was.key) ?? -1];
      const shown = rows[at.index];
      if (
        structural &&
        earlier &&
        shown &&
        joinedAtTop(blockItems(earlier.block), blockItems(shown.block))
      )
        grewAtTop.current = at.key;
    }
    compensate();
  }, [keys, total, rows, indexOf, locate, now, viewport, virtualizer, compensate]);

  const isFollowing = useCallback(() => mode.current.kind === "following", []);
  const toEnd = useCallback((el: HTMLElement) => toEndOf(virtualizer, el), [virtualizer]);
  useStayPinned(viewport, isFollowing, glidingUntil);
  useDockShift(dock, viewport, isFollowing, toEnd);

  return {
    following,
    /** The first row in view, as last observed. */
    top,
    /**
     * Reads the first row in view (after each render and scroll) and refreshes where the held
     * row is, so the next correction counts only what changed since.
     */
    observe: () => {
      const el = viewport.current;
      return el ? look(el) : undefined;
    },
    /** A scroll event, from any cause. */
    scrolled: (el: HTMLElement) => {
      apply(
        {
          type: "scrolled",
          atEnd: distanceToEnd(el) < nearEdge,
          upward: upward.current,
          detached,
          gliding: now() < glidingUntil.current,
        },
        el,
      );
      look(el);
    },
    /** Bring row `index` into view and hold it there while the rows around it measure. */
    jumpTo: (index: number, align: "start" | "center", itemId?: string) => {
      const el = viewport.current;
      const which = el && hold(el, index, itemId);
      if (!el || !which) return;
      apply({ type: "jump", ...which, align, at: now() }, el);
      aimAt(virtualizer, el, index, align);
      hold(el, index, itemId);
      compensate();
    },
    /** Follow the live end again, gliding there or going at once (or not yet: a window loads). */
    toLive: (go?: "glide" | "now") => {
      const el = viewport.current;
      upward.current = false;
      // The glide's own scroll events must not read as the reader scrolling away.
      glidingUntil.current = now() + 800;
      apply({ type: "live" }, el);
      if (el && go === "glide") glideToEnd(el, true);
      else if (el && go === "now") toEndOf(virtualizer, el);
    },
    isFollowing,
  };
}
