/*
 * How a search result line is shown so its match is always on screen, at any panel width: a few
 * characters of what comes before the first match, an ellipsis where that was cut, then the
 * match and the rest of the line (the row's own overflow cuts the end). Offsets are the daemon's
 * UTF-16 ranges inside the preview, which are JavaScript string offsets.
 */

/** One run of a shown preview: plain text or a match. */
export interface PreviewPart {
  text: string;
  match: boolean;
  /** Where the part starts in the preview: -1 for the opening ellipsis. Unique per part. */
  at: number;
}

/** Code units of context kept before the first match. */
export const previewLead = 12;
/** Code units kept after the shown start; a row shows far fewer, this only bounds the DOM. */
export const previewKeep = 240;

const ellipsis = "…";

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** `at` moved off the second half of a surrogate pair, so a wide character is never split. */
function onBoundary(text: string, at: number, forward: boolean): number {
  if (at <= 0 || at >= text.length) return at;
  if (isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1)))
    return forward ? at + 1 : at - 1;
  return at;
}

/** The ranges inside `length`, ordered, empty ones dropped and overlapping ones joined. */
function cleanRanges(
  ranges: readonly (readonly [number, number])[],
  length: number,
): [number, number][] {
  const inside = ranges
    .map(([start, end]): [number, number] => [
      Math.max(0, Math.min(start, length)),
      Math.max(0, Math.min(end, length)),
    ])
    .filter(([start, end]) => end > start)
    .toSorted((a, b) => a[0] - b[0]);
  const joined: [number, number][] = [];
  for (const range of inside) {
    const last = joined.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else joined.push([range[0], range[1]]);
  }
  return joined;
}

/**
 * The parts of `preview` to show. `cutBefore`: the daemon's preview already starts inside the
 * line (its `column` is above 0), so it opens with an ellipsis even when nothing more is cut.
 */
export function previewParts(
  preview: string,
  ranges: readonly (readonly [number, number])[],
  cutBefore = false,
): PreviewPart[] {
  const matches = cleanRanges(ranges, preview.length);
  const first = matches[0]?.[0] ?? 0;
  let start = Math.max(0, first - previewLead);
  // Indentation and blank space before the context carry nothing.
  while (start < first && /\s/.test(preview.charAt(start))) start += 1;
  start = onBoundary(preview, start, true);
  const leadingBlank = /^\s*$/.test(preview.slice(0, start));
  const end = onBoundary(preview, Math.min(preview.length, start + previewKeep), false);
  // A match longer than what is kept still shows whole.
  const stop = Math.max(end, matches.find(([from, to]) => from < end && to > end)?.[1] ?? end);
  const parts: PreviewPart[] = [];
  const push = (text: string, match: boolean, from: number) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last && last.match === match) last.text += text;
    else parts.push({ text, match, at: from });
  };
  if (cutBefore || !leadingBlank) push(ellipsis, false, -1);
  let at = start;
  for (const [from, to] of matches) {
    if (from >= stop) break;
    push(preview.slice(at, from), false, at);
    push(preview.slice(from, Math.min(to, stop)), true, from);
    at = Math.min(to, stop);
  }
  push(preview.slice(at, stop), false, at);
  if (stop < preview.length) push(ellipsis, false, stop);
  return parts;
}
