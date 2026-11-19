/*
 * Ticking a task box in the markdown source of PR and issue text (ADR 0096). The renderer
 * (markit) says where the box it drew sits in the source; ticking rewrites only that box's mark,
 * so the forge's guarded edit changes nothing else in the text.
 */

/** A drawn task box: the offset of the character inside its `[ ]`, and its item's text. */
export interface TaskMark {
  offset: number;
  label: string;
}

/** `source` with the box at `mark` set to `checked`; undefined if the text there isn't a box. */
export function withTask(source: string, mark: TaskMark, checked: boolean): string | undefined {
  const at = mark.offset;
  if (source[at - 1] !== "[" || source[at + 1] !== "]" || !/[ xX]/.test(source[at] ?? ""))
    return undefined;
  return source.slice(0, at) + (checked ? "x" : " ") + source.slice(at + 1);
}
