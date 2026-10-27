/*
 * A command line typed on one line, such as an MCP server's command and its arguments, split
 * into words the way a shell would split it. Pure.
 */

/** A command line split into words, or null when a quote is left open. */
export function splitCommand(text: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) word += text[++index];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < text.length) {
      word += text[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}
