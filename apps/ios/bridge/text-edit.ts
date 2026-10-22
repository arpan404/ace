/*
 * Streaming text as an edit of what native already shows. A row's text is the last 8,192 units
 * of the item, so a delta either extends it or, once it is long, slides it: drop `cut` units from
 * the front, then add `append`. JavaScript decides the edit; native only applies it, after
 * checking that its text is still `base` units long (`ClientModel.applyTextEdits`).
 */

export interface TextEdit {
  /** How many UTF-16 units native's text must hold before the edit. */
  base: number;
  /** UTF-16 units dropped from the front. */
  cut: number;
  append: string;
}

/** How far into `before` an edit may start, so a rewrite costs a bounded search. */
const maxCut = 4096;

/** `after` as an edit of `before`, or undefined when sending it whole is as good or required. */
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

/**
 * The patch to send for a thread item, given what native last confirmed for it: an edit of its
 * text when that is smaller, else the patch itself. Every other row field travels whole.
 */
export function itemPatch(
  patch: Record<string, unknown>,
  held: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (patch.type !== "thread.item" || !held) return patch;
  const row = textOf(patch.row);
  const before = textOf(held.row);
  if (row === undefined || before === undefined) return patch;
  const edit = textEdit(before, row);
  if (!edit) return patch;
  const { text: _text, ...rest } = patch.row as Record<string, unknown>;
  return { ...patch, type: "thread.item.text", row: { ...rest, text: "" }, ...edit };
}

function textOf(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const text: unknown = Reflect.get(row, "text");
  return typeof text === "string" ? text : undefined;
}
