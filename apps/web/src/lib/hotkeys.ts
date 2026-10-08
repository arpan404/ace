import { useEffect, useRef } from "react";
import { keyNameOf, keyboardEnv, useHotkeyBindings } from "./keybindings.ts";
import { parseChord, type Chord, type KeymapId } from "./keymap.ts";

export { parseChord };

/**
 * Whether a keydown is `chord`, its modifiers exactly. On Apple platforms ⌘ ("mod") and ⌃
 * ("ctrl") are separate keys, so ⌃⇧B (Browser) and ⇧⌘B (side panel) never both match, and
 * ⌃⌘Y matches only "ctrl+mod+y". Elsewhere "mod" and "ctrl" are both Ctrl (⊞/Super counts as
 * it too, as the recorder takes it, since the system keeps nearly all of those chords). The key
 * is named as the recorder names it (`keyNameOf`), or by the character typed.
 */
export function matchesChord(
  event: KeyboardEvent,
  chord: Chord,
  isApple: boolean = keyboardEnv().apple,
): boolean {
  const modifiers = isApple
    ? event.metaKey === chord.mod && event.ctrlKey === chord.ctrl
    : (event.ctrlKey || event.metaKey) === (chord.mod || chord.ctrl);
  if (!modifiers || event.shiftKey !== chord.shift || event.altKey !== chord.alt) return false;
  return keyNameOf(event) === chord.key || event.key.toLowerCase() === chord.key;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
  );
}

const sequenceWindowMs = 1000;
const modifierKeys = new Set(["Shift", "Meta", "Control", "Alt"]);

/** Follows one binding ("mod+k", "g h") through a stream of keydowns. */
function sequenceMatcher(keys: string) {
  const chords = keys.split(" ").map(parseChord);
  const plain = chords.length > 1 || !(chords[0]?.mod || chords[0]?.ctrl || chords[0]?.alt);
  let progress = 0;
  let lastAt = 0;
  return (event: KeyboardEvent): boolean => {
    if (plain && isEditable(event.target)) return false;
    if (event.timeStamp - lastAt > sequenceWindowMs) progress = 0;
    const expected = chords[progress];
    if (expected && matchesChord(event, expected)) progress++;
    else progress = chords[0] && matchesChord(event, chords[0]) ? 1 : 0;
    lastAt = event.timeStamp;
    if (progress < chords.length) return false;
    progress = 0;
    return true;
  };
}

/**
 * Keyboard shortcut in keymap notation ("mod+k", "ctrl+`", "g h"). Modifier chords also fire
 * inside text fields (⌘K must open the palette from the composer); plain keys and sequences
 * never do. Owned instead of TanStack Hotkeys (pre-1.0, ADR 0045).
 *
 * Pass `keymap.x.keys`: the user's rebinding of that shortcut applies. Where two shortcuts
 * share a default ("mod+f"), pass `{ id }` too. Literal keys that aren't a keymap default bind
 * as written.
 */
export function useHotkey(
  keys: string,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; id?: KeymapId } = {},
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const enabled = options.enabled ?? true;
  const bindings = useHotkeyBindings(keys, options.id);
  useEffect(() => {
    if (!enabled) return;
    const matchers = bindings.map(sequenceMatcher);
    const listener = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || modifierKeys.has(event.key)) return;
      // Every matcher sees every key, so a sequence in progress isn't lost to another binding.
      const hits = matchers.map((matches) => matches(event));
      if (!hits.some(Boolean)) return;
      event.preventDefault();
      latest.current(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [bindings, enabled]);
}
