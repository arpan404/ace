import { z } from "zod";

/*
 * An agent typing while the person works in the same tab (ADR 0067, "Sharing a tab safely").
 * The person's text and caret are theirs: the agent's text goes after whatever the field holds,
 * and the person's focus, caret and selection come back the moment the text is in. All of it
 * runs in one page task, so none of the person's keystrokes can land in the agent's field.
 */

/** Runs on the field (`this`) in the page; `text` is the agent's. */
export const typeKeepingPerson = `function(text) {
  if (!this.isConnected) throw new Error('detached');
  if (this.disabled || this.readOnly) throw new Error('not editable');
  const doc = this.ownerDocument;
  const editable = typeof this.value === 'string' && typeof this.select === 'function';
  if (!editable && !this.isContentEditable) throw new Error('not editable');
  const before = doc.activeElement;
  const caret = (element) => {
    try {
      if (element && typeof element.selectionStart === 'number')
        return [element.selectionStart, element.selectionEnd, element.selectionDirection];
    } catch {}
    return undefined;
  };
  const beforeCaret = caret(before);
  const selection = doc.getSelection();
  const ranges = [];
  for (let i = 0; i < (selection ? selection.rangeCount : 0); i++)
    ranges.push(selection.getRangeAt(i).cloneRange());
  const had = editable ? this.value : this.textContent ?? '';
  this.focus({ preventScroll: true });
  if (editable) {
    const end = this.value.length;
    let placed = false;
    try { this.setSelectionRange(end, end); placed = true; } catch {}
    // Fields without a caret API (email, number) take their own text back with the agent's.
    if (!placed) { this.select(); text = this.value + text; }
  } else {
    const range = doc.createRange();
    range.selectNodeContents(this);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (!doc.execCommand('insertText', false, text)) throw new Error('not editable');
  // Give the person back where they were: their field, caret and selection.
  if (before && before !== doc.body && before !== this && typeof before.focus === 'function')
    before.focus({ preventScroll: true });
  else if (!before || before === doc.body) this.blur();
  if (beforeCaret && before) {
    try { before.setSelectionRange(beforeCaret[0], beforeCaret[1], beforeCaret[2] ?? 'none'); } catch {}
  } else if (selection) {
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
  }
  return { kept: had.length > 0 };
}`;

export const TypedKeeping = z.object({ kept: z.boolean() });

/** What an agent's `type` tells it when the person's text stayed in the field. */
export const keptText = {
  kept_text: true,
  hint: "The person is working in this tab, so the field's text was kept and yours was added after it. Snapshot to check the field.",
} as const;

const PendingDialog = z.object({ pending_dialog: z.unknown().refine((value) => value != null) });
const KeptText = z.object({ kept_text: z.literal(true) });

/**
 * An agent's `fill_form`, one field at a time: each field is its own `type` that waits for the
 * person, so a person who comes back between two fields is never typed over.
 */
export async function fillFieldByField(
  fields: readonly { ref: string; value: string }[],
  type: (command: { action: "type"; ref: string; text: string }) => Promise<unknown>,
): Promise<unknown> {
  let kept = false;
  for (const field of fields) {
    const result = await type({ action: "type", ref: field.ref, text: field.value });
    // A dialog took the tab: the form stops where it is, as the field's own `type` would.
    if (PendingDialog.safeParse(result).success) return result;
    if (KeptText.safeParse(result).success) kept = true;
  }
  return { ok: true, filled: fields.length, ...(kept ? keptText : {}) };
}
