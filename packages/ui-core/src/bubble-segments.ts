/*
 * How the person's message text reads in its bubble, decided without I/O: which runs are code
 * (fenced blocks, or a whole paste that is plainly code) and whether the message is long enough
 * to fold behind "Show more".
 */

export interface BubbleSegment {
  kind: "text" | "code";
  text: string;
}

/** A message folds past this many lines or characters, showing about `foldedLines`. */
const longLines = 12;
const longChars = 1200;
export const foldedLines = 10;

export function isLongMessage(text: string): boolean {
  return text.length > longChars || text.split("\n").length > longLines;
}

const fence = /^ {0,3}(```|~~~)[^\n]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm;

/** Split text into prose and code runs: fenced blocks always, an unfenced paste when plainly code. */
export function bubbleSegments(text: string): BubbleSegment[] {
  const segments: BubbleSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(last, match.index).replace(/\n$/, "");
    if (before.trim()) segments.push({ kind: "text", text: before });
    segments.push({ kind: "code", text: match[2] ?? "" });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last).replace(/^\n/, "");
  if (!segments.length) return [{ kind: looksLikeCode(text) ? "code" : "text", text }];
  if (rest.trim()) segments.push({ kind: "text", text: rest });
  return segments;
}

const codeLine =
  /[{};]\s*$|^\s*[}\])]|^( {2,}|\t)\S|=>|^\s*(import|export|const|let|var|function|def|class|return|if|for|while|fn|pub|func|package|#include)\b/;

/**
 * Conservative: at least three non-blank lines, nearly all of them shaped like code, and none
 * reading as a prose sentence. A message that merely mentions code stays prose.
 */
export function looksLikeCode(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 3) return false;
  const coded = lines.filter((line) => codeLine.test(line)).length;
  const prose = lines.some((line) => /^[A-Z][a-z]+( [a-z']+){4,}[.?!]$/.test(line.trim()));
  return !prose && coded / lines.length >= 0.75;
}
