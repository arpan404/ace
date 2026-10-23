import { useSyncExternalStore } from "react";

/*
 * GitHub's emoji shortcodes (`:tada:`), from the `gemoji` list GitHub publishes. The list loads
 * on first use as its own chunk, so text without a shortcode never pays for it; text drawn
 * before it arrives shows the shortcode and redraws once it is there. Shortcodes GitHub draws as
 * images of its own (`:octocat:`) aren't in the list and stay text.
 */

let names: ReadonlyMap<string, string> | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function load(): void {
  loading ??= import("gemoji").then(
    ({ gemoji }) => {
      const map = new Map<string, string>();
      for (const entry of gemoji) for (const name of entry.names) map.set(name, entry.emoji);
      names = map;
      for (const listener of listeners) listener();
    },
    () => {
      // A failed chunk load leaves shortcodes as text; the next page asks again.
      loading = undefined;
    },
  );
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => names;

/** A shortcode like `:tada:` somewhere in the text. */
export const shortcodePattern = /:([a-z0-9_+-]{1,64}):/;

/** The shortcode table once loaded (starting its load when `wanted`); undefined until then. */
export function useEmojiNames(wanted: boolean): ReadonlyMap<string, string> | undefined {
  if (wanted && !names) load();
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
