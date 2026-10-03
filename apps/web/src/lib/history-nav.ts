import { useRouter, type RouterHistory } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";

interface NavState {
  canGoBack: boolean;
  canGoForward: boolean;
}
interface Tracker {
  state: NavState;
  subscribe(listener: () => void): () => void;
}

/**
 * Back and forward availability from the router's own history. Entries carry an index; the
 * highest index reached since the last push is the end of the forward stack. After a reload
 * the forward stack is unknown, so forward starts disabled.
 */
function track(history: RouterHistory): Tracker {
  // oxlint-disable-next-line no-underscore-dangle -- TanStack history's own entry index.
  const indexOf = () => history.location.state.__TSR_index ?? 0;
  let top = indexOf();
  const listeners = new Set<() => void>();
  const tracker: Tracker = {
    state: { canGoBack: indexOf() > 0, canGoForward: false },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  history.subscribe(({ action }) => {
    const index = indexOf();
    if (action.type === "PUSH") top = index;
    else top = Math.max(top, index);
    const next = { canGoBack: index > 0, canGoForward: index < top };
    if (
      next.canGoBack === tracker.state.canGoBack &&
      next.canGoForward === tracker.state.canGoForward
    )
      return;
    tracker.state = next;
    for (const listener of listeners) listener();
  });
  return tracker;
}

const trackers = new WeakMap<RouterHistory, Tracker>();
function trackerFor(history: RouterHistory): Tracker {
  let tracker = trackers.get(history);
  if (!tracker) {
    tracker = track(history);
    trackers.set(history, tracker);
  }
  return tracker;
}

export function useHistoryNav(): NavState & { back(): void; forward(): void } {
  const history = useRouter().history;
  const tracker = trackerFor(history);
  const state = useSyncExternalStore(
    tracker.subscribe,
    () => tracker.state,
    () => tracker.state,
  );
  const back = useCallback(() => {
    if (tracker.state.canGoBack) history.back();
  }, [history, tracker]);
  const forward = useCallback(() => {
    if (tracker.state.canGoForward) history.forward();
  }, [history, tracker]);
  return { ...state, back, forward };
}
