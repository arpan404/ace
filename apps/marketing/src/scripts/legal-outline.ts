/*
 * The pieces of a long document's table of contents that need no page: anchor ids made from
 * section headings, and which section is current for a given reading line. Pure, so the legal
 * pages' script stays a thin DOM shell.
 */

/** An anchor id from a heading: lower case, words joined by hyphens, nothing else kept. */
export function anchorId(heading: string): string {
  const id = heading
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "section";
}

/** One id per heading, in order; a heading that repeats gets -2, -3 and so on. */
export function anchorIds(headings: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    const base = anchorId(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

/**
 * The section being read: the last one whose top has passed `line` (both measured from the
 * top of the viewport), or -1 while the reader is still above the first.
 */
export function currentSection(tops: readonly number[], line: number): number {
  let current = -1;
  for (const [index, top] of tops.entries()) {
    if (top <= line) current = index;
    else break;
  }
  return current;
}
