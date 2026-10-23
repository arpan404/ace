import { createContext, useContext } from "react";

/**
 * What a page's Back names, when the page was opened from somewhere other than its own list
 * (a pull request opened from the Inbox says "Inbox"). Undefined keeps the page's own word.
 */
export const BackLabel = createContext<string | undefined>(undefined);

/** The Back label to show: the one the opener set, else `fallback`. */
export function useBackLabel(fallback: string): string {
  return useContext(BackLabel) ?? fallback;
}
