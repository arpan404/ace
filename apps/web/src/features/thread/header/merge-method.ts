import { mergeMethods, type MergeMethod } from "@ace/ui-core";
import { useSyncExternalStore } from "react";

/*
 * The way the person last merged a pull request from ace, remembered on this device: the Work
 * card's Merge uses it, and picking another method in the git menu changes it. Squash until
 * then.
 */

const key = "ace.git.mergeMethod";
const listeners = new Set<() => void>();
const fallback: MergeMethod = "squash";

function read(): MergeMethod {
  let saved: string | null = null;
  try {
    saved = globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    saved = null;
  }
  return mergeMethods.find((each) => each.method === saved)?.method ?? fallback;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function rememberMergeMethod(method: MergeMethod) {
  try {
    globalThis.localStorage?.setItem(key, method);
  } catch {
    // Storage blocked: the method still applies to this merge.
  }
  for (const listener of listeners) listener();
}

export function useMergeMethod(): MergeMethod {
  return useSyncExternalStore(subscribe, read, () => fallback);
}
