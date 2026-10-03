import { diffList, motionMs, withLeaving } from "@ace/ui-core";
import { useEffect, useMemo, useState } from "react";
import { useMediaQuery } from "./media.ts";

/*
 * The motion system's runtime half. CSS owns the curves and keyframes (styles/motion.css);
 * this module decides *when* something is entering, leaving or moving, and keeps a leaving
 * thing mounted long enough to play its exit. Everything collapses to instant under
 * `prefers-reduced-motion`.
 */

const reducedQuery = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  return useMediaQuery(reducedQuery, false);
}

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.(reducedQuery).matches ?? false;
}

export type Phase = "enter" | "exit";

export interface Presence {
  /** Render it: open, or closed but still playing its exit. */
  mounted: boolean;
  phase: Phase;
  /**
   * The open state has changed since mount. Things already open when a view appears should not
   * slide in; only a person's toggle animates.
   */
  toggled: boolean;
}

/** Keeps something mounted for `exitMs` after `open` turns false, so it can play its exit. */
export function usePresence(open: boolean, exitMs: number = motionMs.exit): Presence {
  const reduced = useReducedMotion();
  const [leaving, setLeaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const [toggled, setToggled] = useState(false);
  // Adjusting state while rendering: an open → closed edge starts the exit in the same pass.
  if (wasOpen !== open) {
    setWasOpen(open);
    setToggled(true);
    setLeaving(!open && !reduced);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), exitMs);
    return () => clearTimeout(timer);
  }, [leaving, exitMs]);
  return { mounted: open || leaving, phase: open ? "enter" : "exit", toggled };
}

/** The class for a panel-like surface entering or leaving from `edge`, after a toggle. */
export function panelMotion(presence: Presence): string | undefined {
  if (!presence.toggled) return undefined;
  return presence.phase === "enter" ? "fx-panel-in" : "fx-panel-out";
}

export interface ListRow<T> {
  key: string;
  item: T;
  /** `enter`: arrived in the latest change. `exit`: gone, fading out where it was; draw inert. */
  phase: "enter" | "idle" | "exit";
  /**
   * Moved up past others in the latest change: while the list slides it is drawn above the
   * rows it passes, so two rows never show through each other mid-swap.
   */
  rising: boolean;
}

export interface ListMotion<T> {
  /** The rows to draw: the list plus rows still playing their exit, where they were. */
  rows: readonly ListRow<T>[];
  /** True for a moment after rows changed place, so they slide instead of jumping. */
  moving: boolean;
}

interface Ghost<T> {
  key: string;
  index: number;
  item: T;
}
interface ListState<T> {
  items: readonly T[];
  keys: readonly string[];
  entering: ReadonlySet<string>;
  rising: ReadonlySet<string>;
  ghosts: readonly Ghost<T>[];
  movedAt: number;
}
const noKeys: ReadonlySet<string> = new Set();

/**
 * Choreography for a keyed list: new rows rise in, removed rows fade out where they were, and
 * the rows between slide to their new places. A first fill, a bulk change (filter flip) or
 * reduced motion just shows the new list.
 */
export function useListMotion<T>(items: readonly T[], keyOf: (item: T) => string): ListMotion<T> {
  const reduced = useReducedMotion();
  const [state, setState] = useState<ListState<T>>(() => ({
    items,
    keys: items.map(keyOf),
    entering: noKeys,
    rising: noKeys,
    ghosts: [],
    movedAt: 0,
  }));
  if (state.items !== items) {
    const keys = items.map(keyOf);
    if (sameKeys(state.keys, keys)) setState({ ...state, items, keys });
    else {
      const change = diffList(state.keys, keys);
      const animate = !reduced && !change.bulk;
      const present = new Set(keys);
      const left = change.left.flatMap(({ key, index }) => {
        const item = state.items[index];
        return item === undefined ? [] : [{ key, index, item }];
      });
      const moved = change.reordered || change.entered.length > 0 || left.length > 0;
      setState({
        items,
        keys,
        entering: animate && change.entered.length ? new Set(change.entered) : noKeys,
        rising: animate && change.reordered ? risingKeys(state.keys, keys) : noKeys,
        ghosts: animate ? [...state.ghosts.filter((g) => !present.has(g.key)), ...left] : [],
        movedAt: animate && moved ? state.movedAt + 1 : state.movedAt,
      });
    }
  }
  const { ghosts, movedAt } = state;
  useEffect(() => {
    if (!ghosts.length) return;
    const timer = setTimeout(
      () => setState((current) => ({ ...current, ghosts: [] })),
      motionMs.exit,
    );
    return () => clearTimeout(timer);
  }, [ghosts]);
  const [settledAt, setSettledAt] = useState(movedAt);
  useEffect(() => {
    if (settledAt === movedAt) return;
    const timer = setTimeout(() => {
      setSettledAt(movedAt);
      // Played once: a row scrolled away and back must not rise in again.
      setState((current) => ({ ...current, entering: noKeys, rising: noKeys }));
    }, motionMs.slow + motionMs.exit);
    return () => clearTimeout(timer);
  }, [movedAt, settledAt]);
  const rows = useMemo(() => {
    const byKey = new Map<string, T>();
    state.items.forEach((item, index) => byKey.set(state.keys[index] ?? "", item));
    const leaving = new Map(ghosts.map((ghost) => [ghost.key, ghost.item]));
    const keys = ghosts.length ? withLeaving(state.keys, ghosts) : state.keys;
    return keys.flatMap((key): ListRow<T>[] => {
      const item = byKey.get(key);
      if (item !== undefined)
        return [
          {
            key,
            item,
            phase: state.entering.has(key) ? "enter" : "idle",
            rising: state.rising.has(key),
          },
        ];
      const ghost = leaving.get(key);
      return ghost === undefined ? [] : [{ key, item: ghost, phase: "exit", rising: false }];
    });
  }, [state.items, state.keys, state.entering, state.rising, ghosts]);
  return { rows, moving: settledAt !== movedAt };
}

/** The class a list row plays for its phase. */
export function rowMotion(phase: ListRow<unknown>["phase"]): string | undefined {
  if (phase === "enter") return "fx-rise-in";
  if (phase === "exit") return "fx-fade-out";
  return undefined;
}

/** Rows that stayed and now sit higher among the rows that stayed. */
function risingKeys(previous: readonly string[], next: readonly string[]): ReadonlySet<string> {
  const after = new Set(next);
  const before = new Set(previous);
  const keptBefore = previous.filter((key) => after.has(key));
  const was = new Map(keptBefore.map((key, index) => [key, index]));
  const rising = new Set<string>();
  next
    .filter((key) => before.has(key))
    .forEach((key, index) => {
      if (index < (was.get(key) ?? index)) rising.add(key);
    });
  return rising;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * Run a visual state change (a theme switch) as a cross-fade when the browser supports view
 * transitions and the person hasn't asked for less motion; otherwise just run it.
 */
export function withViewTransition(update: () => void): void {
  const start = globalThis.document?.startViewTransition?.bind(globalThis.document);
  if (!start || prefersReducedMotion()) {
    update();
    return;
  }
  start(update);
}

/** Scroll an element to its end, gliding unless motion is reduced or the jump is huge. */
export function scrollToEnd(element: HTMLElement, smooth: boolean): void {
  const top = element.scrollHeight - element.clientHeight;
  const far = Math.abs(top - element.scrollTop) > element.clientHeight * 3;
  element.scrollTo({
    top,
    behavior: smooth && !far && !prefersReducedMotion() ? "smooth" : "auto",
  });
}
