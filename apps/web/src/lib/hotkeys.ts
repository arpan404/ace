import { useEffect, useRef } from "react";

/** "mod" is ⌘ on Apple platforms and Ctrl elsewhere. */
export type Hotkey = `mod+${string}` | `shift+mod+${string}`;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || !!target.closest("input, textarea, select");
}
export function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  const parts = hotkey.split("+");
  const key = parts.at(-1)?.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  return (
    mod === parts.includes("mod") &&
    event.shiftKey === parts.includes("shift") &&
    !event.altKey &&
    event.key.toLowerCase() === key
  );
}

/**
 * Global keyboard shortcut. Modifier shortcuts also fire inside text fields, because ⌘K
 * must open the palette from the composer. Owned instead of TanStack Hotkeys (pre-1.0).
 */
export function useHotkey(
  hotkey: Hotkey,
  handler: (event: KeyboardEvent) => void,
  options: { inEditable?: boolean } = {},
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const inEditable = options.inEditable ?? true;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.repeat || !matchesHotkey(event, hotkey)) return;
      if (!inEditable && isEditable(event.target)) return;
      event.preventDefault();
      latest.current(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [hotkey, inEditable]);
}
