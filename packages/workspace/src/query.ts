import { WorkspaceError, type SearchOptions } from "./types.ts";

// Expand shorthands to explicit JavaScript character classes for both engines.
// Rust regex otherwise treats \d and \w as Unicode properties, unlike JavaScript.
const classes: Record<string, string> = {
  d: "0-9",
  w: "A-Za-z0-9_",
  s: String.raw`\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`,
};
export function querySource(options: SearchOptions): string {
  if (!options.query || options.query.length > 4096 || /[\r\n\0\u2028\u2029]/.test(options.query)) {
    throw new WorkspaceError(
      "INVALID_ARGUMENT",
      "Query must contain 1 to 4096 characters on one line",
    );
  }
  if (!options.regex) return options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\(\?(?!:)|\\[1-9]|\\[pP]\{|\\[bB]|\\n/.test(options.query)) {
    throw new WorkspaceError(
      "INVALID_ARGUMENT",
      "Regex must use the shared JavaScript/ripgrep subset; no lookaround, backreferences, Unicode classes/boundaries, or multiline expressions",
    );
  }
  try {
    RegExp(options.query, "u");
  } catch (error) {
    throw new WorkspaceError("INVALID_ARGUMENT", "Invalid search expression", error);
  }
  let inClass = false;
  let source = "";
  for (let index = 0; index < options.query.length; index++) {
    const char = options.query.charAt(index);
    if (char === "\\") {
      const escape = options.query.charAt(++index);
      const body = classes[escape.toLowerCase()];
      if (body) {
        const negative = escape !== escape.toLowerCase();
        if (negative && inClass)
          throw new WorkspaceError(
            "INVALID_ARGUMENT",
            "Negated shorthand inside a character class is not supported",
          );
        source += inClass ? body : `[${negative ? "^" : ""}${body}]`;
      } else source += "\\" + escape;
    } else {
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      source += char;
    }
  }
  if (source.length > 16_384)
    throw new WorkspaceError("INVALID_ARGUMENT", "Expanded expression exceeds its size budget");
  return source;
}
/** Both engines see the same physical lines, including CRLF and Unicode separators. */
export function searchText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?|[\u2028\u2029]/g, "\n");
}
