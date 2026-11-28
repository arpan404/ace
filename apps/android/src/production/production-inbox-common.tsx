import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import type { ConnectionState, Selection } from "@ace/client";
import { useSelection } from "../selection.ts";
import type { ProductionInboxEntry } from "./production-inbox.ts";

/**
 * Shared fail-closed read guards for the production inbox views.
 *
 * Every lease below can invalidate (revoked pin, disconnect, host switch), so
 * all selections stay unconditional and fall back to a stable snapshot instead
 * of crashing the render. One module owns them so the single-machine inbox,
 * the thread view and the merged multi-machine inbox share the same guards
 * without duplicating logic or importing each other's views.
 */

export function useNowTick(active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * Re-render driver for unsubscribed reads (startup route, manager failure).
 * Polls lightly while mounted and bumps on foregrounding so background
 * disconnects, revocations and reconnects surface without waiting for the
 * 30s regroup tick. It only triggers renders: lease re-resolution keys on
 * the route identity, not on this tick, so no lease churn.
 */
export function useLivenessTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 2000);
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") setTick((value) => value + 1);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return tick;
}

/**
 * Fail-closed selection read: a selection whose pin failed throws from
 * `getSnapshot`/`subscribe`. Return the fallback instead of crashing the
 * render, so the caller paints its disconnected copy. Hooks stay
 * unconditional; only the returned value switches.
 */
export function useFailClosedSelection<T>(selection: Selection<T>, fallback: T): T {
  const safe = useMemo<Selection<T>>(
    () => ({
      getSnapshot: () => {
        try {
          return selection.getSnapshot();
        } catch {
          return fallback;
        }
      },
      subscribe: (listener: () => void) => {
        try {
          return selection.subscribe(listener);
        } catch {
          return () => {};
        }
      },
    }),
    [selection, fallback],
  );
  return useSelection(safe);
}

/** True when a live-created selection has since failed its pin. Sync, render-safe. */
export function isDeadSelection(selection: Selection<unknown> | null): boolean {
  if (selection === null) return true;
  try {
    selection.getSnapshot();
    return false;
  } catch {
    return true;
  }
}

/**
 * Unconditional hook inputs for invalidated leases: every `select` above can
 * throw once the pin fails, but hooks cannot move, so a dead selection fills
 * in and the views below render the fail-closed copy instead.
 */
export function emptySelection<T>(value: T): Selection<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  };
}
export const noOrder = emptySelection<readonly string[]>([]);
export const noEntries = emptySelection<ProductionInboxEntry[] | undefined>(undefined);
export const noConnection = emptySelection<ConnectionState>("connecting");

/**
 * Stable `useSyncExternalStore` inputs: every fallback/selection below keeps
 * one module identity so the 2s liveness tick re-render never resubscribes
 * and the dead path stays `Object.is`-stable. Inline `[]`/`{}`/`emptySelection`
 * would mint a new identity per render and churn subscriptions.
 */
export const EMPTY_ORDER: readonly string[] = Object.freeze([]);
export const FALLBACK_HEADLINE: { title: string; count: number } = Object.freeze({
  title: "Thread",
  count: 0,
});
export const noUndefined: Selection<undefined> = emptySelection(undefined);
export const noHeadline: Selection<{ title: string; count: number }> =
  emptySelection(FALLBACK_HEADLINE);
