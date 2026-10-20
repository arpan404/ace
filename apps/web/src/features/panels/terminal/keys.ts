/*
 * Who gets a key pressed while a terminal has focus. The shell needs its control keys (^C,
 * ^R, ^P, ^K, ^J...), many of which are also ace shortcuts on Windows and Linux, where "mod"
 * is Ctrl. So inside a terminal:
 *
 * - the terminal keeps plain keys, Alt keys and Ctrl keys (not ⌘ on a Mac);
 * - ace keeps ⌘ shortcuts, Ctrl+Shift shortcuts and Ctrl+Alt shortcuts, plus Ctrl+` (show or
 *   hide the terminal) so there is always a way out of it;
 * - a few keys are the terminal's own commands: copy, paste and find (⌘C/⌘V/⌘F on a Mac,
 *   Ctrl+Shift+C/V/F elsewhere, as desktop terminals do);
 * - on a Mac, ⌘⌫, ⌘⌦, ⌘← and ⌘→ edit the line as in macOS terminals (see lineEditBytes).
 *
 * Pure, so the rule is tested directly.
 */

export type KeyOwner = "terminal" | "app" | "copy" | "paste" | "find";

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const letter = (event: KeyLike) =>
  event.code?.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
const backquote = (event: KeyLike) => event.code === "Backquote" || event.key === "`";

export function keyOwner(event: KeyLike, apple: boolean): KeyOwner {
  if (event.ctrlKey && !event.metaKey && backquote(event)) return "app";
  if (apple) {
    if (event.metaKey) {
      if (event.ctrlKey || event.altKey || event.shiftKey) return "app";
      const key = letter(event);
      if (key === "c") return "copy";
      if (key === "v") return "paste";
      if (key === "f") return "find";
      return "app";
    }
    if (event.ctrlKey && (event.shiftKey || event.altKey)) return "app";
    return "terminal";
  }
  if (event.metaKey) return "app";
  if (event.ctrlKey && event.shiftKey && !event.altKey) {
    const key = letter(event);
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    if (key === "f") return "find";
    return "app";
  }
  if (event.ctrlKey && event.altKey) return "app";
  return "terminal";
}

/*
 * Mac line-editing keys, sent as the readline control bytes macOS terminals send:
 * ⌘⌫ deletes to the line start (^U), ⌘⌦ to the line end (^K), ⌘← and ⌘→ move to the
 * line start (^A) and end (^E). Undefined for any other key.
 */
const lineEdits: Record<string, string> = {
  Backspace: "\x15",
  Delete: "\x0b",
  ArrowLeft: "\x01",
  ArrowRight: "\x05",
};

export function lineEditBytes(event: KeyLike, apple: boolean): string | undefined {
  if (!apple || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined;
  return lineEdits[event.key];
}
