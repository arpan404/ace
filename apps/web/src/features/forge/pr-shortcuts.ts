import type { KeyboardEvent } from "react";

export type PrShortcut = "open" | "summary" | "timeline" | "code" | "checks";

const keys: Record<string, PrShortcut> = {
  o: "open",
  "1": "summary",
  "2": "timeline",
  "3": "code",
  "4": "checks",
};

/**
 * The PR view's single-key shortcuts while it has focus: O open on the host, 1–4 switch tabs.
 * None of them writes: a merge or a copy is never one stray key away. Never while typing, and
 * never with a modifier held, so the app's own chords keep working.
 */
export function prShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">,
): PrShortcut | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]',
    )
  )
    return undefined;
  return keys[event.key.toLowerCase()];
}

export type PrCodeShortcut =
  | "next-file"
  | "previous-file"
  | "next-comment"
  | "previous-comment"
  | "next-unresolved"
  | "next-unviewed"
  | "toggle-viewed";

const codeKeys: Record<string, PrCodeShortcut> = {
  n: "next-file",
  N: "previous-file",
  c: "next-comment",
  C: "previous-comment",
  u: "next-unresolved",
  v: "toggle-viewed",
  V: "next-unviewed",
};

/**
 * The Code tab's review keys, under the same rules as the panel's: N / Shift-N next and
 * previous file, C / Shift-C next and previous conversation, U next unresolved one, V toggle
 * the current file's Viewed mark, Shift-V next unviewed file. Inside the Code tab they take
 * C, which elsewhere copies the checkout command.
 */
export function prCodeShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">,
): PrCodeShortcut | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]',
    )
  )
    return undefined;
  return codeKeys[event.key];
}
