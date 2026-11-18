/**
 * Redrawing an inline region below the prompt (ADR 0178 §9): no alternate screen, only the
 * lines that changed are rewritten. Pure: given what is on screen and what should be, the
 * escape sequences that turn one into the other, and where the cursor ends up.
 *
 * The region's top is where it started; `cursorRow` is the region line the terminal cursor is
 * on. Lines must already fit the terminal's width (views cut them).
 */
export interface Frame {
  readonly lines: readonly string[];
  /** Where the cursor shows (a composer); undefined hides it. */
  readonly cursor?: { readonly row: number; readonly column: number } | undefined;
}

export interface Drawn {
  readonly lines: readonly string[];
  readonly cursorRow: number;
}

export const emptyDrawn: Drawn = { lines: [], cursorRow: 0 };

const up = (count: number) => (count > 0 ? `\x1b[${count}A` : "");
const down = (count: number) => (count > 0 ? `\x1b[${count}B` : "");
const right = (count: number) => (count > 0 ? `\x1b[${count}C` : "");
export const hideCursor = "\x1b[?25l";
export const showCursor = "\x1b[?25h";
const clearLine = "\x1b[2K";
const clearBelow = "\x1b[J";

/** The output that draws `next` over `drawn`, and the new drawn state. */
export function drawFrame(drawn: Drawn, next: Frame): { output: string; drawn: Drawn } {
  const lines = next.lines.length ? next.lines : [""];
  let output = hideCursor;
  let row = drawn.cursorRow;
  // Go to the region's first line.
  output += up(row) + "\r";
  row = 0;
  const old = drawn.lines;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (index >= old.length) {
      // Past the old region: a newline scrolls the terminal when the region reaches the bottom.
      if (index > 0) {
        output += down(index - 1 - row) + "\r\n";
        row = index;
      }
      output += clearLine + line;
      continue;
    }
    if (old[index] === line) continue;
    output += down(index - row) + "\r" + clearLine + line;
    row = index;
  }
  const last = lines.length - 1;
  if (old.length > lines.length) {
    // Rows the region gave up: clear from the first of them down.
    output += down(lines.length - row) + "\r" + clearBelow + up(1);
    row = lines.length - 1;
  }
  if (row !== last && next.cursor === undefined) {
    output += down(last - row);
    row = last;
  }
  if (next.cursor) {
    const target = Math.min(last, Math.max(0, next.cursor.row));
    output += (target > row ? down(target - row) : up(row - target)) + "\r";
    output += right(next.cursor.column) + showCursor;
    row = target;
  }
  return { output, drawn: { lines, cursorRow: row } };
}

/** Clears the whole region and leaves the cursor at its top, ready for other output. */
export function clearFrame(drawn: Drawn): string {
  if (!drawn.lines.length) return "";
  return up(drawn.cursorRow) + "\r" + clearBelow;
}
