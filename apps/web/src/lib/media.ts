import { useSyncExternalStore } from "react";

/** Media query as external state. `fallback` applies where matchMedia is unavailable. */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = globalThis.matchMedia?.(query);
      list?.addEventListener("change", changed);
      return () => list?.removeEventListener("change", changed);
    },
    () => globalThis.matchMedia?.(query).matches ?? fallback,
    () => fallback,
  );
}
