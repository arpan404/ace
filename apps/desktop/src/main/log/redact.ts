import { createTextRedactor, isSecretKey, type RedactionContext } from "@ace/redaction";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";

const OMITTED = "<INVALID STRUCTURED DATA OMITTED>";
/** What the literal redactor returns instead of text it could not redact. */
const FAILED = new Set(["<REDACTION FAILED: TEXT OMITTED>", "<OVERSIZED REDACTED>"]);
/** A quoted or bare key opening an object or array: `"credentials": {`, `auth=[`. */
const CONTAINER = /["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*[[{]/g;

/**
 * Cuts the text at the first secret-named container (`"credentials": {…`): the lexical rules
 * redact one value after a secret key, not every value inside a nested record.
 */
function withoutSecretContainers(text: string): string {
  for (const match of text.matchAll(CONTAINER))
    if (match[1] !== undefined && isSecretKey(match[1]))
      return `${text.slice(0, match.index)}<SECRET>`;
  return text;
}

/**
 * The desktop log's redactor. Lines are first redacted as diagnostics, which read embedded
 * JSON as records. Prose that only looks like JSON (a Node warning's `[DEP0040]`, one line of
 * a pretty-printed error such as `"values": [`) would lose everything after the opener there,
 * so those lines take the literal-text rules instead: credential patterns, quoted and JSON
 * secret assignments, environment values and paths are still replaced, and a secret-named
 * record is cut. The shared redactor is unchanged; only the desktop's lines take this path.
 */
export function createDesktopRedactor(ctx: RedactionContext): (text: string) => string {
  const diagnostic = createDiagnosticRedactor(ctx);
  const literal = createTextRedactor(ctx);
  return (text) => {
    const structured = diagnostic(text);
    if (!structured.includes(OMITTED)) return structured;
    const prose = literal(text);
    return FAILED.has(prose) ? structured : withoutSecretContainers(prose);
  };
}
