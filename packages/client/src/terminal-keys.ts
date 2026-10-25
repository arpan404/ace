/*
 * The bytes a key press sends to a PTY, as xterm-compatible terminals send them. Every client
 * that draws its own terminal input (the web's plain surface, the phone's key bar and hardware
 * keyboards) encodes through here. Pure, so the table is tested directly.
 *
 * Key names follow the DOM's KeyboardEvent.key values: "ArrowUp", "Escape", "PageDown", "F5",
 * or the single character typed.
 */

export interface TerminalKey {
  key: string;
  ctrl?: boolean | undefined;
  alt?: boolean | undefined;
  shift?: boolean | undefined;
}

/** Modes the program in the terminal has set that change what keys send. */
export interface TerminalKeyModes {
  /** DECCKM (`CSI ? 1 h`): arrows, Home and End send SS3 (`ESC O A`) instead of CSI. */
  applicationCursor: boolean;
}

const esc = "\x1b";

/** Keys whose final letter follows CSI or, in application cursor mode, SS3. */
const cursorKeys: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};
/** F1–F4 always use SS3 when unmodified. */
const functionLetters: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };
/** Keys sent as `CSI n ~`. */
const tildeKeys: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/** Ctrl with a non-letter: the control bytes VT terminals have always sent for these. */
const controlSymbols: Record<string, string> = {
  " ": "\x00",
  "@": "\x00",
  "2": "\x00",
  "[": esc,
  "3": esc,
  "\\": "\x1c",
  "4": "\x1c",
  "]": "\x1d",
  "5": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  _: "\x1f",
  "-": "\x1f",
  "/": "\x1f",
  "7": "\x1f",
  "?": "\x7f",
  "8": "\x7f",
};

/** xterm's modifier parameter: 1 + Shift + 2·Alt + 4·Ctrl, or 0 for none. */
function modifierParameter(key: TerminalKey): number {
  const value = (key.shift ? 1 : 0) + (key.alt ? 2 : 0) + (key.ctrl ? 4 : 0);
  return value === 0 ? 0 : value + 1;
}

/** Bytes for `key`, or undefined when the key sends nothing (a bare modifier, an unknown name). */
export function terminalKeyBytes(key: TerminalKey, modes: TerminalKeyModes): string | undefined {
  const modifier = modifierParameter(key);
  const cursor = cursorKeys[key.key];
  if (cursor) {
    if (modifier) return `${esc}[1;${modifier}${cursor}`;
    return `${esc}${modes.applicationCursor ? "O" : "["}${cursor}`;
  }
  const fn = functionLetters[key.key];
  if (fn) return modifier ? `${esc}[1;${modifier}${fn}` : `${esc}O${fn}`;
  const tilde = tildeKeys[key.key];
  if (tilde !== undefined) return modifier ? `${esc}[${tilde};${modifier}~` : `${esc}[${tilde}~`;
  const prefix = key.alt ? esc : "";
  switch (key.key) {
    case "Enter":
      return `${prefix}\r`;
    case "Tab":
      return key.shift ? `${esc}[Z` : `${prefix}\t`;
    case "Backspace":
      return `${prefix}${key.ctrl ? "\x08" : "\x7f"}`;
    case "Escape":
      return `${prefix}${esc}`;
  }
  if ([...key.key].length !== 1) return undefined;
  if (!key.ctrl) return `${prefix}${key.key}`;
  const code = key.key.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return `${prefix}${String.fromCharCode(code - 64)}`;
  return `${prefix}${controlSymbols[key.key] ?? key.key}`;
}
