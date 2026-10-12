import { GitError } from "./types.ts";

function incomplete(): never {
  throw new GitError("publication_scan_incomplete", "Assignment key scan incomplete");
}
function bare(character: string | undefined): boolean {
  return character !== undefined && /^[A-Za-z0-9_/@-]$/.test(character);
}
function horizontal(character: string | undefined): boolean {
  return character === " " || character === "\t";
}
function boundary(character: string | undefined): boolean {
  return character === undefined || /[\s;{,(]/.test(character);
}

/** A forward-only cursor consumes each key once, even when no separator follows it.
 * Limits apply to unfinished keys too. Quoted components are returned without values. */
export function* publicationAssignmentKeys(text: string): Generator<string[]> {
  let position = 0;
  let assignments = 0;
  while (position < text.length) {
    const initial = text[position];
    if (!boundary(text[position - 1]) || (!bare(initial) && initial !== '"' && initial !== "'")) {
      position++;
      continue;
    }
    const start = position;
    const advance = () => {
      if (++position - start > 16384) incomplete();
    };
    const spaces = () => {
      while (horizontal(text[position])) advance();
    };
    const parts: string[] = [];
    let valid = true;
    while (valid) {
      if (parts.length >= 64) incomplete();
      const component = position;
      const quote = text[position];
      if (quote === '"' || quote === "'") {
        advance();
        while (position < text.length && text[position] !== quote) {
          if (text[position] === "\r" || text[position] === "\n") break;
          if (quote === '"' && text[position] === "\\") {
            advance();
            if (position >= text.length || text[position] === "\r" || text[position] === "\n")
              break;
          }
          advance();
        }
        if (text[position] !== quote) {
          valid = false;
          break;
        }
        advance();
      } else {
        while (bare(text[position])) advance();
        // npm's scoped fields use /:_auth and /:_authToken before '='.
        if (text[position] === ":" && text[position - 1] === "/" && bare(text[position + 1])) {
          advance();
          while (bare(text[position])) advance();
        }
        if (position === component) {
          valid = false;
          break;
        }
      }
      parts.push(text.slice(component, position));
      spaces();
      if (text[position] !== ".") break;
      advance();
      spaces();
    }
    if (valid && (text[position] === "=" || text[position] === ":")) {
      advance();
      spaces();
      if (text[position] !== undefined && !/\s/.test(text[position] ?? "")) {
        if (++assignments > 100000) incomplete();
        yield parts;
        // A scalar value is not another candidate key. Leave collection delimiters
        // for the outer cursor so inline JSON objects still expose their fields.
        const quote = text[position];
        if (quote === '"' || quote === "'") {
          position++;
          while (position < text.length) {
            const character = text[position];
            if (character === "\r" || character === "\n") break;
            position++;
            if (character === quote) break;
            if (
              quote === '"' &&
              character === "\\" &&
              position < text.length &&
              text[position] !== "\r" &&
              text[position] !== "\n"
            )
              position++;
          }
        } else {
          while (position < text.length && !/[\s;,{}()]/.test(text[position] ?? "")) position++;
        }
      }
    }
    // Failed candidates resume here, never at an earlier space or component.
  }
}
