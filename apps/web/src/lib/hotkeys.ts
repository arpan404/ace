import { useEffect, useRef } from "react";

interface Chord {
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** "shift+mod+d" → a chord. The final part is the key, so "mod++" and "ctrl+`" parse. */
export function parseChord(text: string): Chord {
  const parts = text.split(/\+(?!$)/).map((part) => part.toLowerCase());
  const key = parts.at(-1) ?? "";
  return {
    key,
    mod: parts.includes("mod"),
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

const physical: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Backslash: "\\",
  Comma: ",",
};

export function matchesChord(event: KeyboardEvent, chord: Chord): boolean {
  // "mod" accepts ⌘ or Ctrl so one binding works everywhere; a bare "ctrl" excludes ⌘.
  const modifiers = chord.mod
    ? event.metaKey || event.ctrlKey
    : chord.ctrl
      ? event.ctrlKey && !event.metaKey
      : !event.metaKey && !event.ctrlKey;
  if (!modifiers || event.shiftKey !== chord.shift || event.altKey !== chord.alt) return false;
  const key = event.key.toLowerCase();
  return key === chord.key || physical[event.code] === chord.key;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || !!target.closest("input, textarea, select");
}

const sequenceWindowMs = 1000;
const modifierKeys = new Set(["Shift", "Meta", "Control", "Alt"]);

/**
 * Global keyboard shortcut in keymap notation ("mod+k", "ctrl+`", "g h"). Modifier chords also
 * fire inside text fields (⌘K must open the palette from the composer); plain keys and
 * sequences never do. Owned instead of TanStack Hotkeys (pre-1.0, ADR 0045).
 */
export function useHotkey(
  keys: string,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean } = {},
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const enabled = options.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const chords = keys.split(" ").map(parseChord);
    const plain = chords.length > 1 || !(chords[0]?.mod || chords[0]?.ctrl || chords[0]?.alt);
    let progress = 0;
    let lastAt = 0;
    const listener = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || modifierKeys.has(event.key)) return;
      if (plain && isEditable(event.target)) return;
      if (event.timeStamp - lastAt > sequenceWindowMs) progress = 0;
      const expected = chords[progress];
      if (expected && matchesChord(event, expected)) progress++;
      else progress = chords[0] && matchesChord(event, chords[0]) ? 1 : 0;
      lastAt = event.timeStamp;
      if (progress < chords.length) return;
      progress = 0;
      event.preventDefault();
      latest.current(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [keys, enabled]);
}
