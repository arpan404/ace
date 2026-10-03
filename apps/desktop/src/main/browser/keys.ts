/** One key press for Electron's `webContents.sendInputEvent`. */
export interface KeyPress {
  /** An Electron accelerator key code ("A", "Enter", "Up", "Plus", "F5"). */
  keyCode: string;
  modifiers: ("shift" | "control" | "alt" | "meta")[];
  /** Text the press types, sent as a `char` event; absent for shortcuts and named keys. */
  text?: string;
}

const modifierNames = new Map<string, KeyPress["modifiers"][number] | "controlOrMeta">([
  ["Shift", "shift"],
  ["Control", "control"],
  ["Alt", "alt"],
  ["Meta", "meta"],
  ["ControlOrMeta", "controlOrMeta"],
]);

/** Playwright key names whose Electron accelerator name differs. */
const renamed = new Map<string, string>([
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  [" ", "Space"],
  ["+", "Plus"],
]);

const named = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Up",
  "Down",
  "Left",
  "Right",
  "Plus",
  "PrintScreen",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  ...Array.from({ length: 24 }, (_value, index) => `F${index + 1}`),
]);

/**
 * Parses a Playwright-style key or chord ("Enter", "a", "Shift+ArrowLeft", "ControlOrMeta+A",
 * "Control++") into one Electron key press. Throws on names it does not know.
 */
export function parseChord(input: string, platform: NodeJS.Platform): KeyPress {
  const parts = input.split("+");
  // "Control++" and a bare "+" name the plus key itself.
  if (input.endsWith("+") && parts.length >= 2) parts.splice(-2, 2, "+");
  const key = parts.pop();
  if (!key) throw new Error(`Unknown key: ${input}`);
  const modifiers = new Set<KeyPress["modifiers"][number]>();
  for (const part of parts) {
    const modifier = modifierNames.get(part);
    if (!modifier) throw new Error(`Unknown modifier: ${part}`);
    modifiers.add(
      modifier === "controlOrMeta" ? (platform === "darwin" ? "meta" : "control") : modifier,
    );
  }
  const shortcut = modifiers.has("control") || modifiers.has("meta") || modifiers.has("alt");
  const press = (keyCode: string, text?: string): KeyPress => ({
    keyCode,
    modifiers: [...modifiers],
    ...(text !== undefined && !shortcut ? { text } : {}),
  });
  const code = /^Key([A-Z])$/.exec(key)?.[1] ?? /^Digit([0-9])$/.exec(key)?.[1];
  if (code) return press(code, modifiers.has("shift") ? code : code.toLowerCase());
  const electron = renamed.get(key) ?? key;
  if (named.has(electron))
    return press(electron, electron === "Space" ? " " : electron === "Plus" ? "+" : undefined);
  if ([...key].length === 1) {
    const text = modifiers.has("shift") ? key.toUpperCase() : key;
    return press(key.toUpperCase(), text);
  }
  throw new Error(`Unknown key: ${input}`);
}
