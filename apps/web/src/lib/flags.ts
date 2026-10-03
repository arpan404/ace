import { useSyncExternalStore } from "react";

/*
 * Experimental features, off by default, switched per device in localStorage:
 * `localStorage.setItem("ace.flag.gpuText", "1")`, then reload.
 * - gpuText: draw very large diffs with the GPU text renderer (WebGPU, else WebGL2).
 */
export type Flag = "gpuText";

export function flagEnabled(flag: Flag): boolean {
  try {
    return globalThis.localStorage?.getItem(`ace.flag.${flag}`) === "1";
  } catch {
    return false;
  }
}

const subscribe = (changed: () => void) => {
  addEventListener("storage", changed);
  return () => removeEventListener("storage", changed);
};

/** A flag's state, following changes made in other tabs. */
export function useFlag(flag: Flag): boolean {
  return useSyncExternalStore(
    subscribe,
    () => flagEnabled(flag),
    () => false,
  );
}
