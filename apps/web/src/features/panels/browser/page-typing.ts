import type { BrowserPageView, ForwardedInput } from "../sources.ts";

/*
 * Typing into a remote page through a local text field (`page-keyboard.tsx`), so a phone's
 * keyboard, autocorrect, swipe typing, dictation, dead keys and IMEs all work. The field holds
 * what was typed since the page's field took focus; each change to it is replayed at the
 * page's caret as Backspace, Delete and inserted text. Pure, so it is tested directly.
 */

type Focus = NonNullable<BrowserPageView["focus"]>;

/** Backspaces and Deletes at the caret, then text inserted there. */
export interface TypedEdit {
  backspaces: number;
  deletes: number;
  text: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const codePoints = (text: string) => [...text].length;

/**
 * The edit that turns `before` (caret at `caretBefore`) into `after` (caret at `caretAfter`):
 * everything between the first difference and the old caret is deleted, then the new text up
 * to the new caret typed. Autocorrect replacing the word behind the caret, a swipe-typed word
 * and a plain keystroke all come out as one edit at the caret.
 */
export function typedEdit(
  before: string,
  caretBefore: number,
  after: string,
  caretAfter: number,
): TypedEdit {
  const limit = Math.min(caretBefore, caretAfter);
  let same = 0;
  while (same < limit && before.charCodeAt(same) === after.charCodeAt(same)) same++;
  // Never split a character made of two UTF-16 units.
  if (same > 0 && isHighSurrogate(before.charCodeAt(same - 1))) same--;
  const tailBefore = before.slice(caretBefore);
  const tailAfter = after.slice(caretAfter);
  return {
    backspaces: codePoints(before.slice(same, caretBefore)),
    deletes: tailBefore.endsWith(tailAfter)
      ? codePoints(tailBefore.slice(0, tailBefore.length - tailAfter.length))
      : 0,
    text: after.slice(same, caretAfter),
  };
}

const press = (key: "Backspace" | "Delete" | "Enter"): ForwardedInput[] => [
  { kind: "key", event: "keyDown", key, code: key, ...(key === "Enter" ? { text: "\r" } : {}) },
  { kind: "key", event: "keyUp", key, code: key },
];

/**
 * The input that replays an edit in the page: key presses for deletions, inserted text in
 * pieces the wire takes, and line breaks as Enter (so a form submits as it would on a keyboard).
 */
export function editInput(edit: TypedEdit): ForwardedInput[] {
  const inputs: ForwardedInput[] = [];
  for (let index = 0; index < edit.backspaces; index++) inputs.push(...press("Backspace"));
  for (let index = 0; index < edit.deletes; index++) inputs.push(...press("Delete"));
  edit.text.split(/\r\n|\n|\r/).forEach((line, index) => {
    if (index > 0) inputs.push(...press("Enter"));
    const points = [...line];
    for (let start = 0; start < points.length; start += 256)
      inputs.push({
        kind: "key",
        event: "char",
        key: "Unidentified",
        text: points.slice(start, start + 256).join(""),
      });
  });
  return inputs;
}

/**
 * Whether a key pressed in the local field is text the field types, so it reaches the page as
 * text rather than as a key event: anything an IME or dead key composes, and on a touch
 * keyboard every plain character (the field needs them for autocorrect).
 */
export function typedLocally(
  event: {
    key: string;
    keyCode: number;
    isComposing: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  },
  touch: boolean,
): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  if (event.key === "Dead" || event.key === "Process" || event.key === "Unidentified") return true;
  return touch && !event.ctrlKey && !event.metaKey && codePoints(event.key) === 1;
}

/** The local field's keyboard, matched to the page's field. */
export interface KeyboardKind {
  inputMode: "text" | "email" | "url" | "tel" | "numeric" | "decimal" | "search" | "none";
  enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send" | undefined;
  /** Off for passwords: no autocorrect, capitals or spellcheck. */
  assisted: boolean;
}
const modes = new Set<KeyboardKind["inputMode"]>([
  "text",
  "email",
  "url",
  "tel",
  "numeric",
  "decimal",
  "search",
  "none",
]);
const hints = new Set<NonNullable<KeyboardKind["enterKeyHint"]>>([
  "enter",
  "done",
  "go",
  "next",
  "previous",
  "search",
  "send",
]);
const byType: Record<string, KeyboardKind["inputMode"]> = {
  email: "email",
  url: "url",
  tel: "tel",
  number: "decimal",
  search: "search",
};
const isMode = (value: string | undefined): value is KeyboardKind["inputMode"] =>
  value !== undefined && modes.has(value as KeyboardKind["inputMode"]);
const isHint = (value: string | undefined): value is NonNullable<KeyboardKind["enterKeyHint"]> =>
  value !== undefined && hints.has(value as NonNullable<KeyboardKind["enterKeyHint"]>);

/** The page's own `inputmode` and `enterkeyhint` win; otherwise the input's type decides. */
export function keyboardKind(focus: Focus): KeyboardKind {
  const mode = focus.inputMode?.toLowerCase();
  const hint = focus.enterKeyHint?.toLowerCase();
  const plain = focus.type === "password" || focus.type === "email" || focus.type === "url";
  return {
    inputMode: isMode(mode) ? mode : (byType[focus.type] ?? "text"),
    enterKeyHint: isHint(hint) ? hint : focus.type === "search" ? "search" : undefined,
    assisted: !plain,
  };
}
