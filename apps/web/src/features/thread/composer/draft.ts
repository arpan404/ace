import type { Mention } from "@ace/protocol";

/** The `@file` or leading `/command` being typed at the caret, if any. Pure. */
export interface Trigger {
  kind: "mention" | "command";
  query: string;
  /** Index of the `@` or `/`. */
  start: number;
  /** Caret index; the token runs from `start` to here. */
  end: number;
}

export function triggerAt(text: string, caret: number): Trigger | undefined {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start--;
  const word = text.slice(start, caret);
  if (word.startsWith("@") && !word.slice(1).includes("@"))
    return { kind: "mention", query: word.slice(1), start, end: caret };
  // Commands only at the very start of the message, as provider CLIs read them.
  if (word.startsWith("/") && start === 0 && !word.slice(1).includes("/"))
    return { kind: "command", query: word.slice(1), start, end: caret };
  return undefined;
}

/** Replace the trigger's token with `insert` plus a space; returns the text and new caret. */
export function accept(
  text: string,
  trigger: Trigger,
  insert: string,
): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const spaced = after.startsWith(" ") ? insert : `${insert} `;
  const next = text.slice(0, trigger.start) + spaced + after;
  return { text: next, caret: trigger.start + spaced.length + (after.startsWith(" ") ? 1 : 0) };
}

/** Files picked from the mention list that are still written in the message. */
export function mentionsIn(text: string, picked: ReadonlySet<string>): Mention[] {
  return [...picked].filter((path) => text.includes(`@${path}`)).map((path) => ({ path }));
}

/**
 * Insert `insert` at the caret as its own word: a space before it unless the caret already
 * follows whitespace or starts the text. Returns the text and the caret after the insert.
 */
export function insertAt(
  text: string,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const spaced = before && !/\s$/.test(before) ? ` ${insert}` : insert;
  return { text: before + spaced + text.slice(caret), caret: caret + spaced.length };
}
