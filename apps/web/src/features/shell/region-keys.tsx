import { useEffect } from "react";
import { findComposerInput } from "@/lib/focus-composer.ts";
import { matchesChord, useHotkey } from "@/lib/hotkeys.ts";
import { useHotkeyBindings } from "@/lib/keybindings.ts";
import { keymap, parseChord } from "@/lib/keymap.ts";
import { cycleRegion, focusRegion } from "./regions.ts";

/** F6 presses this app sends itself, so Base UI's toast viewport still gets its F6. */
const handedOn = new WeakSet<Event>();

/** How many frames the list may take to appear after the sidebar is asked back. */
const sidebarFrames = 20;

/**
 * F6 and ⇧F6 walk the regions (`regions.ts`); ⇧⌘E focuses the thread list (showing the
 * sidebar first if it is put away), ⌘L the composer, and ⌥F6 the notifications. Base UI's toast
 * viewport takes every F6 itself, so the region keys listen in the capture phase and keep the
 * press from it; ⌥F6 then hands it an F6 of its own. The sidebar frame mounts it.
 */
export function RegionKeys(props: {
  /** Shows the sidebar; undefined while it shows already (or this screen has none). */
  showSidebar?: (() => void) | undefined;
}) {
  const next = useHotkeyBindings(keymap.nextRegion.keys, "nextRegion");
  const previous = useHotkeyBindings(keymap.previousRegion.keys, "previousRegion");
  useEffect(() => {
    const pressed = (event: KeyboardEvent, bindings: readonly string[]) =>
      bindings.some((keys) => !keys.includes(" ") && matchesChord(event, parseChord(keys)));
    const listener = (event: KeyboardEvent) => {
      if (handedOn.has(event) || event.repeat) return;
      const step = pressed(event, next) ? 1 : pressed(event, previous) ? -1 : 0;
      if (!step) return;
      // A dialog keeps focus inside itself: regions are the window's, behind it.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]'))
        return;
      event.preventDefault();
      event.stopPropagation();
      cycleRegion(document, step);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [next, previous]);

  useHotkey(keymap.focusToasts.keys, () => {
    const press = new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true });
    handedOn.add(press);
    window.dispatchEvent(press);
  });
  useHotkey(keymap.focusComposer.keys, () => findComposerInput()?.focus({ preventScroll: true }));
  useHotkey(keymap.focusThreadList.keys, () => {
    props.showSidebar?.();
    let left = sidebarFrames;
    const look = () => {
      if (!focusRegion(document, "sidebar") && --left > 0) requestAnimationFrame(look);
    };
    look();
  });
  return null;
}
