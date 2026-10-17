/*
 * A long paste (a log, a file's contents) goes with the message as a text file instead of
 * flooding the input; a short one is typed in as usual. Pure.
 */

/** Characters past which a paste becomes a file. */
const maxInlineChars = 2048;
/** Lines past which a paste becomes a file. */
const maxInlineLines = 40;

/** The text file a paste becomes, or undefined to paste it inline. */
export function pastedFile(text: string): { name: string; lines: number } | undefined {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/).length;
  if (text.length <= maxInlineChars && lines <= maxInlineLines) return undefined;
  return { name: `Pasted ${lines} ${lines === 1 ? "line" : "lines"}.txt`, lines };
}
