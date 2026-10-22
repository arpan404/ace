import type { Change, Selection } from "./edits.ts";

/** What a textarea holds and has selected, as the pure edits read it. */
export function selectionOf(field: HTMLTextAreaElement): Selection {
  return { value: field.value, start: field.selectionStart, end: field.selectionEnd };
}

/**
 * Apply `change` to the textarea as typing would: through the browser's own `insertText`, so
 * it is one step on the native undo stack and fires the `input` event a controlled field
 * listens to. Where that command is missing (older engines, jsdom) the text is replaced
 * directly and `input` dispatched, which keeps the field correct but not undoable.
 */
export function applyChange(field: HTMLTextAreaElement, change: Change): void {
  field.focus();
  field.setSelectionRange(change.from, change.to);
  const command = change.insert ? "insertText" : "delete";
  let done = false;
  if (change.from !== change.to || change.insert) {
    try {
      done =
        typeof document.execCommand === "function" &&
        document.execCommand(command, false, change.insert);
    } catch {
      done = false;
    }
    if (!done) {
      field.setRangeText(change.insert, change.from, change.to, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  field.setSelectionRange(change.select[0], change.select[1]);
}
