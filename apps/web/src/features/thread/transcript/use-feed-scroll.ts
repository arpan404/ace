import type { Virtualizer } from "@tanstack/react-virtual";
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
  heldKey,
  transition,
  type Held,
  type ScrollEvent,
  type ScrollMode,
} from "./scroll-mode.ts";
import { useDockShift, useStayPinned } from "./scroll.ts";
import { createScrollMemory, restoreAt, type SavedScroll } from "./scroll-memory.ts";

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

/** Reading positions of the threads left this session. */
export const threadScrolls = createScrollMemory();

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
  rule: ((start: number) => boolean) | undefined,
): void {
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = rule && ((item) => rule(item.start));
}

export function useFeedScroll(options: FeedScrollOptions) {
  const { viewport, dock, virtualizer, rows, keys, total, detached, now, onDirection } = options;
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
      const start = index < 0 ? undefined : virtualizer.measurementsCache[index]?.start;
      return start === undefined ? undefined : { index, start, key: keys[index] ?? key };
    },
    [indexOf, keys, rows, virtualizer],
  );
  /** Which resizes the virtualizer answers by moving the view, for the current mode. */
  const compensate = useCallback(() => {
    const at = mode.current.kind === "anchoring" ? held.current : undefined;
    compensateBy(virtualizer, compensation(mode.current, at && locate(at.key, at.itemId)?.start));
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
    (index: number, itemId?: string) => {
      const row = rows[index];
      const start = virtualizer.measurementsCache[index]?.start;
      if (!row) return undefined;
      const id = itemId ?? blockItems(row.block)[0];
      if (start !== undefined) held.current = { key: row.key, itemId: id, start };
      return { key: row.key, itemId: id };
    },
    [rows, virtualizer],
  );

  // The reader's gestures, before the scrolls they cause.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    return listenScrollIntent(
      el,
      (up) => {
        upward.current = up;
        if (up) glidingUntil.current = 0;
        onDirection(up);
        const atEnd = distanceToEnd(el) < nearEdge;
        apply({ type: "gesture", upward: up, atEnd, detached, at: now() }, el);
      },
      () => apply({ type: "press", at: now() }, el),
    );
  }, [viewport, apply, detached, now, onDirection]);

  // Opening or closing a disclosure holds its row still: what changes is below its toggle.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const click = (event: MouseEvent) => {
      const toggle = event.target instanceof Element ? event.target.closest(disclosure) : null;
      const row = toggle?.closest<HTMLElement>("[data-index]");
      if (!row || !el.contains(row)) return;
      const which = hold(Number(row.dataset.index));
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
    const start = at && virtualizer.measurementsCache[at.index]?.start;
    if (!at || !row || start === undefined || mode.current.kind !== "following") return;
    apply({ type: "toggle", key: row.key, itemId: blockItems(row.block)[0] }, el);
    placeAt(virtualizer, el, start - at.offset);
    hold(at.index);
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
  const previous = useRef({ keys, total });
  useLayoutEffect(() => {
    const structural = previous.current.keys !== keys;
    const grew = previous.current.total !== total;
    previous.current = { keys, total };
    const el = viewport.current;
    if (!el || (mode.current.kind === "following" ? !structural && !grew : !structural)) return;
    const was = held.current;
    const at = was && locate(was.key, was.itemId);
    const fix = correction(mode.current, was, at, now());
    if (fix.kind === "end") toEndOf(virtualizer, el);
    else if (fix.kind === "shift") placeAt(virtualizer, el, el.scrollTop + fix.by);
    else if (fix.kind === "aim") aimAt(virtualizer, el, fix.index, fix.align);
    if (was && at) held.current = { ...was, key: at.key, start: at.start };
    compensate();
  }, [keys, total, locate, now, viewport, virtualizer, compensate]);

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
      if (!el) return undefined;
      const fold = el.scrollTop + options.topRoom;
      const first = virtualizer.getVirtualItems().find((item) => item.end > fold);
      if (!first) return undefined;
      top.current = { index: first.index, offset: first.start - el.scrollTop };
      const row = rows[first.index];
      const shown = row && { key: row.key, itemId: blockItems(row.block)[0] };
      const which = heldKey(mode.current, shown);
      const at = which && locate(which.key, which.itemId);
      held.current = which && at ? { ...which, key: at.key, start: at.start } : undefined;
      return first;
    },
    /** A scroll event, from any cause. */
    scrolled: (el: HTMLElement) =>
      apply(
        {
          type: "scrolled",
          atEnd: distanceToEnd(el) < nearEdge,
          upward: upward.current,
          detached,
          gliding: now() < glidingUntil.current,
        },
        el,
      ),
    /** Bring row `index` into view and hold it there while the rows around it measure. */
    jumpTo: (index: number, align: "start" | "center", itemId?: string) => {
      const el = viewport.current;
      const which = hold(index, itemId);
      if (!el || !which) return;
      apply({ type: "jump", ...which, align, at: now() }, el);
      aimAt(virtualizer, el, index, align);
      hold(index, itemId);
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
