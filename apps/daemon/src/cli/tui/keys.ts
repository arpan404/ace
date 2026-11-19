/**
 * Key presses from the bytes a terminal sends in raw mode (ADR 0178 §9). Pure: the shell hands
 * in each chunk it reads and gets back the keys in it. Bracketed paste arrives as one `paste`
 * key, so pasted newlines never submit a prompt.
 */
export type KeyName =
  | "char"
  | "paste"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "tab"
  | "backtab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "unknown";

export interface Key {
  readonly name: KeyName;
  /** The typed or pasted text, for `char` and `paste`; the control letter for Ctrl keys. */
  readonly text?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly alt?: boolean | undefined;
  readonly shift?: boolean | undefined;
}

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";

/** CSI final bytes and `~` codes that name a key. */
const csiFinal: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "backtab",
};
const tildeCodes: Record<string, KeyName> = {
  "1": "home",
  "2": "unknown",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

/** Modifier parameter of a CSI sequence (`1;5C`): 2 shift, 3 alt, 5 ctrl, sums of those. */
function modifiers(parameter: string | undefined): Pick<Key, "ctrl" | "alt" | "shift"> {
  const value = Number(parameter ?? "1") - 1;
  if (!Number.isFinite(value) || value <= 0) return {};
  return {
    ...(value & 1 ? { shift: true } : {}),
    ...(value & 2 ? { alt: true } : {}),
    ...(value & 4 ? { ctrl: true } : {}),
  };
}

/** One control byte (other than ESC) as its key. */
function control(code: number): Key {
  if (code === 13 || code === 10) return { name: "enter" };
  if (code === 9) return { name: "tab" };
  if (code === 127 || code === 8) return { name: "backspace" };
  if (code === 0) return { name: "char", text: " ", ctrl: true };
  return { name: "char", text: String.fromCharCode(code + 96), ctrl: true };
}

/** Reads an escape sequence at `at` (which holds ESC); returns the key and its length. */
function escape(input: string, at: number): { key: Key; length: number } {
  const next = input[at + 1];
  if (next === undefined) return { key: { name: "escape" }, length: 1 };
  if (next === "[" || next === "O") {
    // CSI: parameters (digits and ;) then one final byte. SS3 (`ESC O x`) has no parameters.
    let end = at + 2;
    while (end < input.length && /[0-9;]/.test(input[end] ?? "")) end++;
    const final = input[end];
    if (final === undefined) return { key: { name: "escape" }, length: 1 };
    const parameters = input.slice(at + 2, end).split(";");
    const length = end - at + 1;
    if (final === "~") {
      const name = tildeCodes[parameters[0] ?? ""] ?? "unknown";
      return { key: { name, ...modifiers(parameters[1]) }, length };
    }
    const name = csiFinal[final];
    if (name)
      return {
        key: { name, ...modifiers(parameters[1]), ...(final === "Z" ? { shift: true } : {}) },
        length,
      };
    return { key: { name: "unknown" }, length };
  }
  if (next === "\x1b") return { key: { name: "escape" }, length: 1 };
  // ESC then a key is that key with Alt held: Alt+Enter, Alt+b.
  const code = next.charCodeAt(0);
  if (code < 32 || code === 127) return { key: { ...control(code), alt: true }, length: 2 };
  const char = String.fromCodePoint(next.codePointAt(0) ?? code);
  return { key: { name: "char", text: char, alt: true }, length: 1 + char.length };
}

/** The keys in one chunk of terminal input. */
export function decodeKeys(input: string): Key[] {
  const keys: Key[] = [];
  let at = 0;
  while (at < input.length) {
    if (input.startsWith(pasteStart, at)) {
      const end = input.indexOf(pasteEnd, at + pasteStart.length);
      const stop = end < 0 ? input.length : end;
      keys.push({ name: "paste", text: input.slice(at + pasteStart.length, stop) });
      at = end < 0 ? input.length : end + pasteEnd.length;
      continue;
    }
    const code = input.charCodeAt(at);
    if (code === 27) {
      const read = escape(input, at);
      keys.push(read.key);
      at += read.length;
      continue;
    }
    if (code < 32 || code === 127) {
      // A CR LF pair from a pasted line ending is one Enter.
      if (code === 13 && input.charCodeAt(at + 1) === 10) at++;
      keys.push(control(code));
      at++;
      continue;
    }
    const char = String.fromCodePoint(input.codePointAt(at) ?? code);
    keys.push({ name: "char", text: char });
    at += char.length;
  }
  return keys;
}

/** A plain typed character (no Ctrl or Alt), or undefined. */
export function typed(key: Key): string | undefined {
  return key.name === "char" && !key.ctrl && !key.alt ? key.text : undefined;
}

/** Whether `key` is Ctrl and the letter `letter`. */
export function isCtrl(key: Key, letter: string): boolean {
  return key.name === "char" && key.ctrl === true && key.text === letter;
}
