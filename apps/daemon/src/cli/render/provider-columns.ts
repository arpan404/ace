/**
 * Aligned columns for the provider and access lists: each cell padded to its column's widest,
 * empty trailing cells dropped, two spaces between. Pure; widths count code points, so a name
 * with accents lines up.
 */
export function columns(rows: readonly (readonly (string | undefined)[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, [...(cell ?? "")].length);
    });
  return rows.map((row) => {
    const last = row.findLastIndex((cell) => !!cell);
    return row
      .slice(0, last + 1)
      .map((cell, index) => (index === last ? (cell ?? "") : pad(cell ?? "", widths[index] ?? 0)))
      .join("  ");
  });
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - [...text].length));
}

/** A count and its noun: "1 model", "3 models". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
