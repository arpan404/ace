import { gitDiffFileLimit } from "@ace/protocol";

/*
 * One page of one file's working-tree patch (`git.diff` with `path`). The whole-checkout read
 * stops at 256 KiB, so a long file is read alone, page by page: each page ends on a line break
 * where it can, and says where the next one starts. Pure over the text git produced.
 */

/** UTF-16 code units in one page: the reply's `patch` limit. */
export const diffPageSize = 262_144;

/**
 * Bytes of one file's patch git is read for: decoded, never more code units than the paging
 * limit, so every page of a file comes from one bounded read (held by `FilePatchCache`).
 */
export const filePatchBytes = gitDiffFileLimit;

export interface DiffPage {
  patch: string;
  truncated: boolean;
  nextOffset?: number;
}

/**
 * The page of `text` (what git produced, cut when `cut`) starting at `offset`. A page is cut at
 * its last line break; a single line longer than a page is cut mid-line, never inside a
 * surrogate pair. Past `gitDiffFileLimit`, the rest is reported as truncated with no next page.
 */
export function diffPage(
  text: string,
  cut: boolean,
  offset: number,
  page = diffPageSize,
): DiffPage {
  const start = Math.min(offset, text.length);
  const want = start + page;
  if (text.length <= want && !cut) return { patch: text.slice(start), truncated: false };
  let end = Math.min(text.length, want);
  if (end <= start) return { patch: "", truncated: true };
  const lineEnd = text.lastIndexOf("\n", end - 1);
  if (lineEnd >= start && lineEnd + 1 < end) end = lineEnd + 1;
  else {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff && end - 1 > start) end--;
  }
  const more = end < text.length && end <= gitDiffFileLimit;
  return more
    ? { patch: text.slice(start, end), truncated: true, nextOffset: end }
    : { patch: text.slice(start, end), truncated: true };
}
