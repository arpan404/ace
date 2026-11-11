import { stepHighlight } from "@ace/ui-core";

/*
 * The keys every combobox list in the palette shares (Add project's Local folder, its folder
 * search, GitHub repositories): ↑ ↓ (and Ctrl-N / Ctrl-P) move the highlight, wrapping; Enter
 * picks the highlighted row, ⌘Enter (Ctrl-Enter off Apple) picks it the other way. Everything
 * else, and any key while an input method is composing, is left to the field. Pure: the hook
 * in `use-list-highlight.ts` applies the result.
 */

/** The parts of a key event the list reads. */
export interface ListKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** An input method is composing: the key belongs to it. */
  isComposing: boolean;
}

/** What a key does to the list. */
export type ListKeyAction =
  | { kind: "move"; to: number | undefined }
  | { kind: "pick"; at: number; how: "open" | "alternate" }
  | { kind: "pass" };

const pass: ListKeyAction = { kind: "pass" };

/**
 * What `event` does to a list of `count` rows with `current` highlighted. `pickable` says
 * whether a row may be picked (a stale or disabled one may not); Enter on such a row, or with
 * nothing highlighted, passes, so the field or its form can act on it. `apple` picks ⌘ over Ctrl
 * as the modifier.
 */
export function listKey(
  event: ListKeyEvent,
  list: { current: number | undefined; count: number; pickable(at: number): boolean },
  apple: boolean,
): ListKeyAction {
  if (event.isComposing) return pass;
  const mod = apple ? event.metaKey : event.ctrlKey;
  const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (event.key === "ArrowDown" || (ctrlOnly && event.key === "n"))
    return { kind: "move", to: stepHighlight(list.current, 1, list.count) };
  // ⌘↑ is the field's own (up a folder); plain ↑ moves.
  if ((event.key === "ArrowUp" && !mod) || (ctrlOnly && event.key === "p"))
    return { kind: "move", to: stepHighlight(list.current, -1, list.count) };
  if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
    const at = list.current;
    if (at === undefined || at >= list.count || !list.pickable(at)) return pass;
    return { kind: "pick", at, how: mod ? "alternate" : "open" };
  }
  return pass;
}

/**
 * Whether a row may be picked, by keys or pointer alike: never while the list is `blocked`
 * (its machine went away, its folder was refused), nor a row still showing from the last query
 * or one marked disabled.
 */
export function canPick(
  row: { stale?: boolean | undefined; disabled?: boolean | undefined } | undefined,
  blocked: boolean,
): boolean {
  return row !== undefined && !blocked && !row.stale && !row.disabled;
}
