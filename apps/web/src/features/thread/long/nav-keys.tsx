import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useThreadNav, type ThreadNav } from "./nav.tsx";

/** Open the search bar and put the caret in it. */
export function findInThread(nav: ThreadNav): void {
  nav.setSearchOpen(true);
  nav.searchFocus.set(nav.searchFocus.get() + 1);
}

/**
 * The ways into a long thread from the keyboard: search it (⌘F) and its turns (⌥⌘G). Bound with
 * the thread screen, so they work before the tools' code has loaded; the header's ⋯ menu lists
 * them too.
 */
export function LongThreadHotkeys() {
  const nav = useThreadNav();
  // "mod+f" is also the terminal's find: name the shortcut so its rebinding applies.
  useHotkey(keymap.findInThread.keys, () => findInThread(nav), { id: "findInThread" });
  useHotkey(keymap.turns.keys, () => nav.setTurnsOpen(!nav.turnsOpen));
  return null;
}
