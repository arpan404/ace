import { useSyncExternalStore } from "react";

/**
 * Whether the page is on screen. Services that stream (browser frames, device screens, clocks) pause
 * while it is hidden and catch up when it is shown; they take this so tests can hide the page.
 */
export interface PageVisibility {
  visible(): boolean;
  watch(changed: () => void): () => void;
}

/** The document's Page Visibility (always visible where there is no document). */
export const documentVisibility: PageVisibility = {
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  watch(changed) {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  },
};

/** Whether the page is on screen, kept live. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    documentVisibility.watch,
    documentVisibility.visible,
    documentVisibility.visible,
  );
}
