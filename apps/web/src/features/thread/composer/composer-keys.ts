import type { KeyboardEvent } from "react";
import { matchesChord } from "@/lib/hotkeys.ts";
import type { Chord } from "@/lib/keymap.ts";

/** The open suggestion list, as the keyboard drives it. */
export interface KeyList {
  count: number;
  active: number;
  /** Still loading or failed: Enter waits instead of sending the half-typed command. */
  pending: boolean;
  move(index: number): void;
  pick(): void;
  dismiss(): void;
}

/** What the composer's keys do, given by the composer for this render. */
export interface ComposerKeys {
  /** The suggestion list, while it shows. */
  list: KeyList | undefined;
  newline(): void;
  history(step: "undo" | "redo"): void;
  /** Walk the sent messages (↑ older, ↓ newer); false when the key should move the caret instead. */
  recall(direction: "older" | "newer"): boolean;
  /** Esc asks to stop; undefined when there's nothing to stop. */
  stopKey: ((at: number) => void) | undefined;
  /** The key that sends the other way (Settings › Keyboard; ⌘↵ by default). */
  other: Chord;
  /** Enter, or `other` with `true`. */
  submit(other: boolean): void;
}

/**
 * The composer's keyboard, in priority order: IME composition passes through untouched; ⌘Z,
 * ⇧⌘Z and Ctrl+Y walk the composer's history; ⇧↵ breaks the line; an open suggestion list takes
 * the arrows, Home, End, Enter, Tab and Esc; ↑ and ↓ walk the sent messages;
 * Esc asks to stop; the other send key sends the other way; Enter sends.
 */
export function composerKeyDown(event: KeyboardEvent<HTMLElement>, keys: ComposerKeys): void {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  const key = event.key;
  const letter = key.toLowerCase();
  const modified = event.metaKey || event.ctrlKey;
  const done = () => event.preventDefault();
  const other = matchesChord(event.nativeEvent, keys.other);
  if (modified && !event.altKey && (letter === "z" || (letter === "y" && !event.metaKey))) {
    done();
    keys.history(letter === "y" || event.shiftKey ? "redo" : "undo");
    return;
  }
  if (key === "Enter" && event.shiftKey && !other) {
    done();
    keys.newline();
    return;
  }
  const list = keys.list;
  if (list) {
    const last = list.count - 1;
    if (list.count && (key === "ArrowDown" || key === "ArrowUp")) {
      done();
      const step = key === "ArrowDown" ? 1 : -1;
      list.move((list.active + step + list.count) % list.count);
      return;
    }
    if (list.count && (key === "Home" || key === "End")) {
      done();
      list.move(key === "Home" ? 0 : last);
      return;
    }
    if (list.count && (key === "Enter" || key === "Tab")) {
      done();
      list.pick();
      return;
    }
    if (key === "Enter" && list.pending) {
      done();
      return;
    }
    if (key === "Escape") {
      done();
      list.dismiss();
      return;
    }
  }
  const plain = !modified && !event.altKey && !event.shiftKey;
  const arrow = key === "ArrowUp" ? "older" : key === "ArrowDown" ? "newer" : undefined;
  if (arrow && plain && !list && keys.recall(arrow)) {
    done();
    return;
  }
  // Esc only asks: the owner decides whether this press stops (a second one, soon) or arms.
  if (key === "Escape" && keys.stopKey) {
    done();
    keys.stopKey(event.timeStamp);
    return;
  }
  if (other || key === "Enter") {
    done();
    keys.submit(other);
  }
}
