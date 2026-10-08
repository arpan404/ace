import { formatKeys, parseChord } from "./keymap.ts";

const nativeKeys: Record<string, string> = {
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  escape: "Escape",
  space: "Space",
  enter: "Return",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
};
/** The shared key recorder's notation, encoded for the desktop contract. */
export function desktopAccelerator(keys: string): string {
  const chord = parseChord(keys);
  return [
    chord.mod && "CommandOrControl",
    chord.ctrl && "Control",
    chord.alt && "Alt",
    chord.shift && "Shift",
    nativeKeys[chord.key] ?? chord.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join("+");
}
/** Show existing desktop choices in platform glyphs, never as an accelerator code. */
export function desktopShortcutLabel(accelerator: string | null): string {
  if (!accelerator) return "Off";
  const parts = accelerator.split(/\+(?!$)/);
  const key = parts.pop()?.toLowerCase();
  if (!key) return "Custom shortcut";
  const aliases: Record<string, string> = {
    commandorcontrol: "mod",
    cmdorctrl: "mod",
    command: "mod",
    cmd: "mod",
    control: "ctrl",
    ctrl: "ctrl",
    alt: "alt",
    option: "alt",
    shift: "shift",
  };
  const modifiers = parts.map((part) => aliases[part.toLowerCase()]);
  if (modifiers.some((part) => !part)) return "Custom shortcut";
  const name =
    Object.entries(nativeKeys).find(([, native]) => native.toLowerCase() === key)?.[0] ?? key;
  return formatKeys([...modifiers, name].join("+"));
}
