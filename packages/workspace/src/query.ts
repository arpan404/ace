import { WorkspaceError, type SearchOptions } from "./types.ts";

// Expand shorthands to explicit JavaScript character classes for both engines.
// Rust regex otherwise treats \d and \w as Unicode properties, unlike JavaScript.
const classes: Record<string, string> = {
  d: "0-9",
  w: "A-Za-z0-9_",
  s: String.raw`\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`,
};
export function querySource(options: SearchOptions): string {
  if (
    !options.query ||
    !options.query.isWellFormed() ||
    options.query.length > 4096 ||
    /[\r\n\0\u2028\u2029]/.test(options.query)
  ) {
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
      const tail = options.query.slice(index + 1);
      const hex =
        escape === "x"
          ? tail.slice(0, 2)
          : escape === "u"
            ? tail.startsWith("{")
              ? tail.slice(1, tail.indexOf("}"))
              : tail.slice(0, 4)
            : "";
      const scalar = hex ? Number.parseInt(hex, 16) : -1;
      if (scalar === 10 || (scalar >= 0xd800 && scalar <= 0xdfff))
        throw new WorkspaceError(
          "INVALID_ARGUMENT",
          "Newline and surrogate escapes are outside the shared regex subset",
        );
      if (
        escape === "c" ||
        escape === "0" ||
        (escape === "u" && /^[dD][89a-fA-F][0-9a-fA-F]{2}/.test(options.query.slice(index + 1)))
      )
        throw new WorkspaceError(
          "INVALID_ARGUMENT",
          "Control, NUL and surrogate escapes are outside the shared regex subset",
        );
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
      if (
        (inClass && char === "[") ||
        (char === "[" &&
          (options.query.charAt(index + 1) === "]" ||
            options.query.slice(index + 1, index + 3) === "^]")) ||
        (inClass && /[&|~]/.test(char) && options.query.charAt(index + 1) === char)
      )
        throw new WorkspaceError(
          "INVALID_ARGUMENT",
          "Nested/empty classes and class set operators are outside the shared regex subset",
        );
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
export function normalizeLines(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029]/g, "\n");
}
