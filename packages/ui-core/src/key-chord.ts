/*
 * Key presses as people read them on a Mac: "⌘L", "⇧⌘T", "Return", "↓". Agents name keys three
 * ways (computer use's key and modifiers, a legacy macOS key code, Playwright's "Control+a"), and
 * every one reads the same. Pure.
 */

const modifierSymbols: Record<string, string> = {
  control: "⌃",
  ctrl: "⌃",
  option: "⌥",
  alt: "⌥",
  shift: "⇧",
  command: "⌘",
  cmd: "⌘",
  meta: "⌘",
  super: "⌘",
  controlormeta: "⌘",
};
/** macOS order: ⌃ ⌥ ⇧ ⌘. */
const modifierOrder = ["⌃", "⌥", "⇧", "⌘"];

const named: Record<string, string> = {
  enter: "Return",
  return: "Return",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  space: "Space",
  " ": "Space",
  backspace: "Delete",
  delete: "Delete",
  forwarddelete: "Forward Delete",
  arrowup: "↑",
  up: "↑",
  arrowdown: "↓",
  down: "↓",
  arrowleft: "←",
  left: "←",
  arrowright: "→",
  right: "→",
  pageup: "Page Up",
  pagedown: "Page Down",
  home: "Home",
  end: "End",
};

/** macOS virtual key codes (ANSI layout) a legacy key press may carry. */
const keyCodes: Record<number, string> = {
  0: "A",
  1: "S",
  2: "D",
  3: "F",
  4: "H",
  5: "G",
  6: "Z",
  7: "X",
  8: "C",
  9: "V",
  11: "B",
  12: "Q",
  13: "W",
  14: "E",
  15: "R",
  16: "Y",
  17: "T",
  31: "O",
  32: "U",
  34: "I",
  35: "P",
  36: "Return",
  37: "L",
  38: "J",
  40: "K",
  45: "N",
  46: "M",
  48: "Tab",
  49: "Space",
  51: "Delete",
  53: "Esc",
  123: "←",
  124: "→",
  125: "↓",
  126: "↑",
};

/** One key's name: "L", "Return", "↓", "F5". */
export function keyName(key: string): string {
  const known = named[key.toLowerCase()];
  if (known) return known;
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function chord(modifiers: readonly string[], key: string): string {
  const symbols = new Set(
    modifiers.map((modifier) => modifierSymbols[modifier.toLowerCase()]).filter(Boolean),
  );
  const prefix = modifierOrder.filter((symbol) => symbols.has(symbol)).join("");
  return `${prefix}${key}`;
}

/** "⌘L" for key "l" with command; a legacy key code by its key ("⌘L" for 37). */
export function keyChord(key: string | number, modifiers: readonly string[] = []): string {
  const name = typeof key === "number" ? (keyCodes[key] ?? `key ${key}`) : keyName(key);
  return chord(modifiers, name);
}

/** Playwright's "Control+a", "Meta+Shift+T", "Enter" or "Shift++". */
export function playwrightChord(combo: string): string {
  if (combo === "+") return "+";
  const parts = combo.split("+");
  // "Shift++": the last key is "+" itself.
  if (combo.endsWith("++")) parts.splice(-2, 2, "+");
  const key = parts.pop() ?? combo;
  return chord(parts, keyName(key));
}
