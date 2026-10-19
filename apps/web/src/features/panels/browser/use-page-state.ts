import { useCallback, useSyncExternalStore } from "react";
import type { BrowserPageView, PreviewSource } from "../sources.ts";

/** A tab's page state as the daemon last reported it; undefined while it reports none. */
export function usePageState(
  source: PreviewSource,
  threadId: string,
  tabId: string | undefined,
): BrowserPageView | undefined {
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener, threadId),
    [source, threadId],
  );
  return useSyncExternalStore(subscribe, () =>
    tabId === undefined ? undefined : source.page?.(threadId, tabId),
  );
}

/**
 * The CSS cursor the page shows under the person's pointer (`default` until it reports one),
 * for the pane and for anything that draws a cursor of its own over the page.
 */
export function usePageCursor(
  source: PreviewSource,
  threadId: string,
  tabId: string | undefined,
): string {
  return usePageState(source, threadId, tabId)?.cursor ?? "default";
}
