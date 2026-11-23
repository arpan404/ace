/*
 * Streaming fields as edits of what native already shows. A row's text is the last 8,192 units
 * of the item, so a delta either extends it or, once it is long, slides it: drop `cut` from the
 * front, then add `append`. JavaScript decides the edit; native only applies it, after checking
 * that the field is still `base` long (`ClientModel.resolveTextEdits`). On the wire `base` and
 * `cut` count UTF-8 bytes, which Swift's strings count without transcoding.
 */

export interface TextEdit {
  /** How long native's text must be before the edit. */
  base: number;
  /** How much is dropped from its front. */
  cut: number;
  append: string;
}

/** How far into `before` an edit may start, so a rewrite costs a bounded search. */
const maxCut = 4096;

/**
 * `after` as an edit of `before` in UTF-16 units, or undefined when sending it whole is as good
 * or required.
 */
export function textEdit(before: string, after: string): TextEdit | undefined {
  if (after === before) return undefined;
  for (let cut = 0; cut <= Math.min(before.length, maxCut); cut++) {
    const kept = before.length - cut;
    if (kept > after.length) continue;
    if (!after.startsWith(cut === 0 ? before : before.slice(cut))) continue;
    // Never start or end the kept part inside a surrogate pair.
    if (isLow(before.charCodeAt(cut)) || isHigh(before.charCodeAt(before.length - 1)))
      return undefined;
    const append = after.slice(kept);
    // An edit worth sending replaces most of the text, not little of it.
    if (append.length * 2 > after.length) return undefined;
    return { base: before.length, cut, append };
  }
  return undefined;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** What native last confirmed of a streaming item's row: its text, and the rest as JSON. */
export interface HeldRow {
  text: string;
  rest: string;
  field?: "stepOutput";
}

/** A row's fields apart from its text, as JSON, to tell whether only the text changed. */
export function restOf(row: Record<string, unknown>): string {
  const { text: _text, ...rest } = row;
  return JSON.stringify(rest);
}

/** The growing field and the other fields that must still agree with native's copy. */
export function heldRow(row: Record<string, unknown>): HeldRow | undefined {
  const output = stepOutput(row);
  if (output) return output;
  return typeof row.text === "string" ? { text: row.text, rest: restOf(row) } : undefined;
}

function stepOutput(row: Record<string, unknown>): HeldRow | undefined {
  if (row.type !== "tool_call" || !record(row.step) || !record(row.step.detail)) return undefined;
  const { output, ...detail } = row.step.detail;
  if (typeof output !== "string") return undefined;
  return {
    field: "stepOutput",
    text: output,
    rest: JSON.stringify({ ...row, step: { ...row.step, detail } }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The patch to send for a thread item, given the row native last confirmed for it (`held`): an
 * compact edit of its text or command output. A text edit can carry other changed fields.
 * An output edit keeps the acknowledged command and requires the other fields to match.
 */
export function itemPatch(
  patch: Record<string, unknown>,
  held: HeldRow | undefined,
  utf8Length: (text: string) => number,
): Record<string, unknown> {
  if (patch.type !== "thread.item" || held === undefined || !record(patch.row)) return patch;
  const { row, ...scope } = patch;
  const next = heldRow(row);
  if (!next || next.field !== held.field) return patch;
  const { text, rest, field } = next;
  if (text === held.text || (field && rest !== held.rest)) return patch;
  // Even replacing the entire output field leaves the command and row metadata on native.
  const edit =
    textEdit(held.text, text) ?? (field ? { cut: held.text.length, append: text } : undefined);
  if (!edit) return patch;
  const base = utf8Length(held.text);
  const cut = edit.cut && utf8Length(held.text.slice(0, edit.cut));
  return {
    ...scope,
    type: "thread.item.text",
    ...(field ? { field } : {}),
    ...(rest === held.rest ? {} : { row: { ...row, text: "" } }),
    base,
    cut,
    append: edit.append,
  };
}
