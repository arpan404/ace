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

/**
 * Keeps something mounted while it plays its exit. `mounted` stays true for `exitMs` after
 * `open` turns false; `phase` says which animation to play.
 */
export function usePresence(
  open: boolean,
  exitMs: number = motionMs.exit,
): { mounted: boolean; phase: Phase } {
  const reduced = useReducedMotion();
  const [leaving, setLeaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  // Adjusting state while rendering: an open → closed edge starts the exit in the same pass.
  if (wasOpen !== open) {
    setWasOpen(open);
    setLeaving(!open && !reduced);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), exitMs);
    return () => clearTimeout(timer);
  }, [leaving, exitMs]);
  return { mounted: open || leaving, phase: open ? "enter" : "exit" };
}

export interface ListMotion {
  /** The keys to draw: the list plus rows still playing their exit, where they were. */
  keys: readonly string[];
  /** Rows that arrived in the latest change. */
  entering: ReadonlySet<string>;
  /** Rows on their way out; draw them inert. */
  leaving: ReadonlySet<string>;
  /** True for a moment after rows changed place, so they slide instead of jumping. */
  moving: boolean;
}

interface ListState {
  keys: readonly string[];
  entering: ReadonlySet<string>;
  ghosts: readonly { key: string; index: number }[];
  movedAt: number;
}
const noKeys: ReadonlySet<string> = new Set();

/**
 * Choreography for a keyed list: new rows rise in, removed rows fade out where they were, and
 * the rows between slide to their new places. A first render, a bulk change (filter flip) or
 * reduced motion just shows the new list.
 */
export function useListMotion(keys: readonly string[]): ListMotion {
  const reduced = useReducedMotion();
  const [state, setState] = useState<ListState>(() => ({
    keys,
    entering: noKeys,
    ghosts: [],
    movedAt: 0,
  }));
  if (state.keys !== keys && !sameKeys(state.keys, keys)) {
    const change = diffList(state.keys, keys);
    const animate = !reduced && !change.bulk;
    setState({
      keys,
      entering: animate && change.entered.length ? new Set(change.entered) : noKeys,
      ghosts: animate ? [...state.ghosts.filter((g) => !keys.includes(g.key)), ...change.left] : [],
      movedAt:
        animate && (change.reordered || change.entered.length || change.left.length)
          ? state.movedAt + 1
          : state.movedAt,
    });
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
      setState((current) => ({ ...current, entering: noKeys }));
    }, motionMs.slow + motionMs.exit);
    return () => clearTimeout(timer);
  }, [movedAt, settledAt]);
  return useMemo(() => {
    const drawn = ghosts.length ? withLeaving(state.keys, ghosts) : state.keys;
    return {
      keys: drawn,
      entering: state.entering,
      leaving: ghosts.length ? new Set(ghosts.map((g) => g.key)) : noKeys,
      moving: settledAt !== movedAt,
    };
  }, [state.keys, state.entering, ghosts, settledAt, movedAt]);
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
