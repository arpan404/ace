import type { HistoryPager } from "@ace/client-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { JumpSnapshot } from "../long/jump-controller.ts";
import type { ThreadNav } from "../long/nav.tsx";

/*
 * Paging history in as the reader scrolls toward either end of what is loaded. Only scrolls
 * backed by reader intent may page: older history loads one request per upward gesture, well
 * before the edge, so paging in never surfaces as a visible jump. A reply, a jump settling, or a
 * keep-place restore fires scroll events with no gesture behind them, and those must never walk
 * the history by themselves. Newer history (a jumped window back toward live) loads the same
 * way, mirrored.
 */

/** The reader's last gesture toward older or newer history, one page each. */
export function usePagingIntent() {
  const [older, setOlder] = useState(false);
  const [newer, setNewer] = useState(false);
  return {
    older,
    newer,
    setOlder,
    setNewer,
    /** The reader's gesture direction. */
    onDirection: useCallback((upward: boolean) => {
      setOlder(upward);
      setNewer(!upward);
    }, []),
  };
}

export interface HistoryPagingOptions {
  intent: ReturnType<typeof usePagingIntent>;
  viewport: RefObject<HTMLDivElement | null>;
  pager: HistoryPager;
  jump: JumpSnapshot;
  nav: ThreadNav;
  /** A window that isn't joined to the live tail. */
  detached: boolean;
  following: boolean;
}

const distanceToLive = (el: HTMLElement | null) =>
  el ? el.scrollHeight - el.scrollTop - el.clientHeight : Number.POSITIVE_INFINITY;

export function useHistoryPaging(options: HistoryPagingOptions) {
  const { viewport, pager, jump, nav, detached, following } = options;
  const { older: olderIntent, newer: newerIntent, setOlder: setOlderIntent } = options.intent;
  const setNewerIntent = options.intent.setNewer;
  const window = jump.window;
  const focus = jump.focus;
  const { hasOlder, loading, loadOlder } = pager;
  const maybeLoadOlder = useCallback(
    (scrollTop: number) => {
      if (
        olderIntent &&
        scrollTop < 900 &&
        hasOlder &&
        !loading &&
        !pager.error &&
        !jump.failed &&
        !jump.loading
      ) {
        setOlderIntent(false);
        void loadOlder();
      }
    },
    [
      olderIntent,
      hasOlder,
      loading,
      pager.error,
      jump.failed,
      jump.loading,
      loadOlder,
      setOlderIntent,
    ],
  );
  const prefetchFocus = useRef(focus?.nonce);
  useEffect(() => {
    if (prefetchFocus.current !== focus?.nonce) {
      prefetchFocus.current = focus?.nonce;
      setOlderIntent(false);
      setNewerIntent(false);
      return;
    }
    if (olderIntent && !following) {
      const top = viewport.current?.scrollTop ?? 0;
      if (top < 1200 && hasOlder && !loading && !pager.error && !jump.failed) {
        setOlderIntent(false);
        void loadOlder();
      }
    }
  }, [
    viewport,
    focus?.nonce,
    olderIntent,
    following,
    hasOlder,
    loading,
    pager.error,
    jump.failed,
    loadOlder,
    setOlderIntent,
    setNewerIntent,
  ]);
  // A wheel or key at the very bottom moves no scroll offset, so the intent effect below must
  // page on its own; scroll events with no gesture behind them never do, so a page settling
  // can't chain into the next one and stick the view flickering.
  const maybeLoadNewer = useCallback(
    (distance: number) => {
      if (
        newerIntent &&
        distance < 900 &&
        detached &&
        window &&
        !jump.loading &&
        !loading &&
        !pager.error &&
        !jump.failed
      ) {
        setNewerIntent(false);
        void nav.jump.newer();
      }
    },
    [
      newerIntent,
      detached,
      window,
      jump.loading,
      jump.failed,
      loading,
      pager.error,
      nav.jump,
      setNewerIntent,
    ],
  );
  useEffect(() => {
    if (prefetchFocus.current !== focus?.nonce) return;
    if (newerIntent && !following && detached && window) {
      const distance = distanceToLive(viewport.current);
      if (distance < 1200 && !jump.loading && !loading && !pager.error && !jump.failed) {
        setNewerIntent(false);
        void nav.jump.newer();
      }
    }
  }, [
    viewport,
    focus?.nonce,
    newerIntent,
    following,
    detached,
    window,
    jump.loading,
    jump.failed,
    loading,
    pager.error,
    nav.jump,
    setNewerIntent,
  ]);
  return {
    onScroll: (el: HTMLElement) => {
      maybeLoadNewer(distanceToLive(el));
      maybeLoadOlder(el.scrollTop);
    },
    /** Back to live: no gesture is pending. */
    reset: () => {
      setOlderIntent(false);
      setNewerIntent(false);
    },
  };
}
