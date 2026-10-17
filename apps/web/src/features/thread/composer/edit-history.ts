import type { ComposerToken } from "@ace/ui-core";

/*
 * The composer's own undo history. The browser's undo stack can't follow the message once a
 * chip is inserted or the editor is rebuilt from state, so ⌘Z / ⇧⌘Z walk these snapshots
 * instead. Typing coalesces into word-sized steps, as native undo does. Pure.
 */

export interface EditSnapshot {
  text: string;
  tokens: readonly ComposerToken[];
  caret: number;
}

interface Run {
  kind: "insert" | "delete";
  /** Where the caret ended after the run's last step. */
  caret: number;
  /** The run's last inserted character was whitespace. */
  space: boolean;
}

export interface EditHistory {
  readonly past: readonly EditSnapshot[];
  readonly future: readonly EditSnapshot[];
  readonly run: Run | undefined;
}

export const emptyHistory: EditHistory = { past: [], future: [], run: undefined };

/** Steps kept; older ones fall off. */
const limit = 200;

/** One typed or deleted character at the caret, if that is what changed. */
function typingStep(before: EditSnapshot, after: EditSnapshot): Run | undefined {
  const { text, caret } = before;
  if (after.text.length === text.length + 1 && after.caret === caret + 1) {
    const typed = after.text[caret] ?? "";
    if (after.text === text.slice(0, caret) + typed + text.slice(caret))
      return { kind: "insert", caret: after.caret, space: /\s/.test(typed) };
  }
  if (after.text.length === text.length - 1) {
    const backward =
      after.caret === caret - 1 && after.text === text.slice(0, caret - 1) + text.slice(caret);
    const forward =
      after.caret === caret && after.text === text.slice(0, caret) + text.slice(caret + 1);
    if (backward || forward) return { kind: "delete", caret: after.caret, space: false };
  }
  return undefined;
}

/** Record that the message changed from `before` to `after`. A caret move alone records nothing. */
export function recordEdit(
  history: EditHistory,
  before: EditSnapshot,
  after: EditSnapshot,
): EditHistory {
  if (before.text === after.text && before.tokens === after.tokens) return history;
  const step = typingStep(before, after);
  const run = history.run;
  // A word starts a new step: the first space after letters breaks the run.
  const continues =
    !!step &&
    !!run &&
    run.kind === step.kind &&
    run.caret === before.caret &&
    !(step.kind === "insert" && step.space && !run.space);
  if (continues) return { past: history.past, future: [], run: step };
  return { past: [...history.past, before].slice(-limit), future: [], run: step };
}

/** Step back: the snapshot to show, and the history after it. Undefined when nothing is left. */
export function undoEdit(
  history: EditHistory,
  current: EditSnapshot,
): { history: EditHistory; snapshot: EditSnapshot } | undefined {
  const snapshot = history.past.at(-1);
  if (!snapshot) return undefined;
  return {
    snapshot,
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current],
      run: undefined,
    },
  };
}

/** Step forward again after an undo. Undefined when nothing was undone since the last edit. */
export function redoEdit(
  history: EditHistory,
  current: EditSnapshot,
): { history: EditHistory; snapshot: EditSnapshot } | undefined {
  const snapshot = history.future.at(-1);
  if (!snapshot) return undefined;
  return {
    snapshot,
    history: {
      past: [...history.past, current],
      future: history.future.slice(0, -1),
      run: undefined,
    },
  };
}
