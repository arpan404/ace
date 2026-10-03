import { useSeconds } from "@/lib/time.ts";

/**
 * Wall-clock time, re-rendering every second while `live`, for "Working for 12s" and
 * background task ages. One shared timer for every live row, paused while the page is hidden.
 */
export function useTicker(live: boolean): number {
  return useSeconds(live);
}
