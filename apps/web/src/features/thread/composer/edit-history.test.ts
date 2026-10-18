import { expect, test } from "vitest";
import {
  emptyHistory,
  recordEdit,
  redoEdit,
  undoEdit,
  type EditHistory,
  type EditSnapshot,
} from "./edit-history.ts";

const at = (text: string, caret = text.length): EditSnapshot => ({ text, tokens: [], caret });

/** Type `text` one character at a time from an empty message. */
function typed(text: string): { history: EditHistory; current: EditSnapshot } {
  let history = emptyHistory;
  let current = at("");
  for (const char of text) {
    const next = at(current.text + char);
    history = recordEdit(history, current, next);
    current = next;
  }
  return { history, current };
}

function undoAll(history: EditHistory, current: EditSnapshot): string[] {
  const seen: string[] = [];
  for (let step = undoEdit(history, current); step; step = undoEdit(history, current)) {
    ({ history } = step);
    current = step.snapshot;
    seen.push(current.text);
  }
  return seen;
}

test("undo takes typing back a word at a time", () => {
  const { history, current } = typed("fix the bug");
  expect(undoAll(history, current)).toEqual(["fix the", "fix", ""]);
});

test("a pasted block or inserted chip is one undo step of its own", () => {
  const { history, current } = typed("see");
  const pasted = at("see a long pasted block");
  const after = recordEdit(history, current, pasted);
  expect(undoAll(after, pasted)).toEqual(["see", ""]);
});

test("deleting characters undoes as one step, separate from the typing before it", () => {
  let { history, current } = typed("hello");
  for (const text of ["hell", "hel"]) {
    const next = at(text);
    history = recordEdit(history, current, next);
    current = next;
  }
  expect(undoAll(history, current)).toEqual(["hello", ""]);
});

test("redo replays what undo took back until a new edit is made", () => {
  const { history, current } = typed("one two");
  const undone = undoEdit(history, current);
  expect(undone?.snapshot.text).toBe("one");
  if (!undone) return;
  const redone = redoEdit(undone.history, undone.snapshot);
  expect(redone?.snapshot.text).toBe("one two");
  if (!redone) return;
  const back = undoEdit(redone.history, redone.snapshot);
  if (!back) throw new Error("nothing to undo after redo");
  const edited = recordEdit(back.history, back.snapshot, at("one!"));
  expect(redoEdit(edited, at("one!"))).toBeUndefined();
});

test("moving the caret records nothing, and typing elsewhere starts a new step", () => {
  let { history, current } = typed("ab");
  const moved = { ...current, caret: 0 };
  expect(recordEdit(history, current, moved)).toBe(history);
  const next = { text: "xab", tokens: [], caret: 1 };
  history = recordEdit(history, moved, next);
  expect(undoAll(history, next)).toEqual(["ab", ""]);
});
