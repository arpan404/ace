// SPDX-License-Identifier: Apache-2.0

/**
 * Reading source for the device catalog check: which lines hold a literal, and which lines are
 * a `#[cfg(test)]` item. A test may name a word it asserts on, but everything after a test
 * module is source again, so only that item's block is skipped.
 */

/** The line numbers a quoted literal sits on, as the source spells it. */
export function findLiteral(text: string, literal: string): number[] {
  const lines: number[] = [];
  const needle = JSON.stringify(literal);
  text.split("\n").forEach((line, index) => {
    if (line.includes(needle)) lines.push(index + 1);
  });
  return lines;
}

/** Skip strings, character literals and comments, so their braces never count. */
function codeAt(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = skipString(text, index);
      continue;
    }
    if (char === "'") {
      index = skipChar(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    return index;
  }
  return -1;
}

function skipString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index++;
  }
  return text.length;
}

function skipChar(text: string, start: number): number {
  // A lifetime (`'a`) is not a character literal; only a closing quote after one unit is.
  if (text[start + 2] === "'") return start + 3;
  if (text[start + 1] === "\\") {
    let index = start + 2;
    while (index < text.length && text[index] !== "'") index++;
    return index + 1;
  }
  return start + 1;
}

/** The index of the first `{` at or after `start`, outside strings and comments. */
function openBrace(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    index = codeAt(text, index);
    if (index === -1) return -1;
    if (text[index] === "{") return index;
    index++;
  }
  return -1;
}

/** The index of the `}` that closes the block opened at `start`. */
function closeBrace(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    index = codeAt(text, index);
    if (index === -1) return text.length - 1;
    if (text[index] === "{") depth++;
    if (text[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return text.length - 1;
}

/** The source with every `#[cfg(test)]` item blanked out, line numbers preserved. */
export function stripTestItems(text: string): string {
  let output = "";
  let index = 0;
  for (;;) {
    const at = text.indexOf("#[cfg(test)]", index);
    if (at === -1) return output + text.slice(index);
    output += text.slice(index, at);
    const brace = openBrace(text, at + "#[cfg(test)]".length);
    if (brace === -1) return output + text.slice(at).replace(/[^\n]/g, " ");
    const end = closeBrace(text, brace);
    const skipped = text.slice(at, end + 1);
    output += skipped.replace(/[^\n]/g, " ");
    index = end + 1;
  }
}
