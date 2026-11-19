/*
 * A long paste (a log, a file's contents) goes with the message as a text file instead of
 * flooding the input; a short one is typed in as usual. Pure.
 */

/** Characters past which a paste becomes a file. */
const maxInlineChars = 2048;
/** Lines past which a paste becomes a file. */
const maxInlineLines = 40;

/** A paste's file name, as `pastedFile` gives it. */
const pastedName = /^Pasted \d+ lines?\.txt$/;

function lineCount(text: string): number {
  return text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function nameFor(lines: number): string {
  return `Pasted ${lines} ${lines === 1 ? "line" : "lines"}.txt`;
}

/** The text file a paste becomes, or undefined to paste it inline. */
export function pastedFile(text: string): { name: string; lines: number } | undefined {
  const lines = lineCount(text);
  if (text.length <= maxInlineChars && lines <= maxInlineLines) return undefined;
  return { name: nameFor(lines), lines };
}

/** Whether a file is one a paste became, by its name. */
export function isPasted(name: string): boolean {
  return pastedName.test(name);
}

/** A text file's name once edited: a paste's name follows its new line count, others stay. */
export function editedName(name: string, text: string): string {
  return isPasted(name) ? nameFor(lineCount(text)) : name;
}
