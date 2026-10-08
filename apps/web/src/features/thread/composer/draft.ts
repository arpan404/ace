import type { Mention, ContentPart, ThreadRefContextItem } from "@ace/protocol";
import type { LocalAttachment } from "@/components/attachment-format.ts";

/** A message the composer hands over on Enter. */
export interface Draft {
  text: string;
  input?: ContentPart[] | undefined;
  threadRefs?: ThreadRefContextItem[] | undefined;
  mentions: Mention[];
  /** Files the daemon already holds. */
  attachments: { sha256: string }[];
  /**
   * Every file attached, handed over from the composer (`useAttachments().handOff()`): as the
   * pending bubble shows them, the ones still uploading, and when they've all settled.
   */
  files: {
    local: LocalAttachment[];
    uploading: number;
    settled: Promise<{ sha256: string; name: string }[]>;
    /** Each file's own outcome, in `local`'s order. */
    outcomes: Promise<({ sha256: string; name: string } | { error: string })[]>;
    /** The files themselves, in `local`'s order, for an upload to be retried. */
    files: (File | undefined)[];
    release(): void;
  };
  /** ⌘↵ / Ctrl+↵: the opposite of the follow-up default (steer instead of queue, or back). */
  opposite: boolean;
}

/** The `@file` or `/command` being typed at the caret, if any. Pure. */
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
  if (word.startsWith("/") && !word.slice(1).includes("/"))
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
