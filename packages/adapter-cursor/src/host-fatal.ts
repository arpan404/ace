/**
 * The SDK host's last words. An uncaught error in the host stops it; before stopping, the host
 * writes one tagged stderr line so the parent can say why Cursor stopped instead of guessing
 * from whatever stderr line happened to come last. Pure: no I/O here.
 */
const tag = "ace-cursor-host fatal: ";
const maxDetail = 2048;

/**
 * One stderr line naming the uncaught error, without its stack or any newline. `redact` sees the
 * whole message first: shortening or joining lines before redaction could split a secret so it
 * no longer matches.
 */
export function fatalLine(
  kind: "uncaughtException" | "unhandledRejection",
  error: unknown,
  redact: (text: string) => string,
): string {
  const name = error instanceof Error ? error.name : undefined;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const text = `${kind}: ${name && name !== "Error" ? `${name}: ` : ""}${redact(message)}`
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxDetail);
  return `${tag}${text}\n`;
}

/** The reason a tagged fatal line carries, or undefined for any other stderr line. */
export function fatalDetail(line: string): string | undefined {
  const at = line.indexOf(tag);
  if (at < 0) return undefined;
  return line.slice(at + tag.length).trim() || undefined;
}

/**
 * Stderr lines that never explain a stop: blank lines, stack frames, Node's version banner and
 * its process-warning lines ("(node:123) Warning: …", "(Use `node --trace-warnings …`)").
 */
export function isNoiseLine(line: string): boolean {
  return (
    !line.trim() ||
    /^\s*at\s/.test(line) ||
    line.startsWith("node:internal/") ||
    /^Node\.js v\d/.test(line) ||
    /^\(node:\d+\) /.test(line) ||
    line.startsWith("(Use `node --trace-")
  );
}
