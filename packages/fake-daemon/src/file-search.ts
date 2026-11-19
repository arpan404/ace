import type { FileOperation, FileSearchFile, FileSearchSummary } from "@ace/protocol";

type SearchOperation = Extract<FileOperation, { op: "search" }>;

/** A gitignore-style glob as a test of a checkout path (or its last part, for a bare name). */
function globTest(glob: string): (path: string) => boolean {
  let source = "";
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at] ?? "";
    if (glob.startsWith("**/", at)) {
      source += "(?:.*/)?";
      at += 2;
    } else if (glob.startsWith("**", at)) {
      source += ".*";
      at += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const pattern = new RegExp(`^${source}$`);
  const bare = !glob.includes("/");
  return (path) => pattern.test(path) || (bare && pattern.test(path.split("/").at(-1) ?? ""));
}

/** The pattern as the daemon's ace-files would read it: literal or regex, case, whole word. */
function matcher(op: SearchOperation): RegExp | undefined {
  const sensitive =
    op.case === "sensitive" || (op.case === "smart" && op.pattern !== op.pattern.toLowerCase());
  const body = op.regex ? op.pattern : op.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(op.wholeWord ? `\\b(?:${body})\\b` : body, sensitive ? "g" : "gi");
  } catch {
    return undefined;
  }
}

/**
 * Content search over a fixture checkout, as the daemon answers it: matches in path order, one
 * entry per file, UTF-16 ranges into a whole-line preview, stopping at `maxMatches`.
 */
export function searchCheckout(
  paths: readonly string[],
  read: (path: string) => Uint8Array | undefined,
  op: SearchOperation,
): { files: FileSearchFile[]; summary: FileSearchSummary } | { error: string } {
  const pattern = matcher(op);
  if (!pattern) return { error: "INVALID_ARGUMENT" };
  const included = op.include.map(globTest);
  const excluded = op.exclude.map(globTest);
  const files: FileSearchFile[] = [];
  let matches = 0;
  let truncated = false;
  for (const path of paths) {
    if (path.endsWith("/") || truncated) continue;
    if (included.length && !included.some((test) => test(path))) continue;
    if (excluded.some((test) => test(path))) continue;
    const bytes = read(path);
    if (!bytes || bytes.length > op.maxFileBytes) continue;
    const lines = new TextDecoder().decode(bytes).split("\n");
    const found: FileSearchFile["lines"] = [];
    for (const [index, text] of lines.entries()) {
      const ranges: [number, number][] = [];
      for (const match of text.matchAll(pattern)) {
        if (!match[0].length) continue;
        if (matches >= op.maxMatches) {
          truncated = true;
          break;
        }
        matches++;
        ranges.push([match.index, match.index + match[0].length]);
      }
      if (ranges.length)
        found.push({ line: index + 1, column: 0, preview: text.slice(0, 400), ranges });
      if (truncated) break;
    }
    if (found.length) files.push({ path, lines: found });
  }
  return { files, summary: { files: files.length, matches, truncated } };
}
