/*
 * File references in agent prose: `loader.ts`, `src/app/x.tsx:42`, `apps/web/src/a.ts#L10`.
 * Detection is deliberately conservative: a reference must look like a file (a name with a
 * letter-led extension), never a URL, an email or a version number. Inline code may hold a bare
 * filename; plain text needs a folder (`a/b.ts`) or a line (`b.ts:12`) before it counts, so
 * words like "Node.js" stay words. Resolution picks a unique workspace path from candidates the
 * caller found (the checkout's path index); it never guesses between two.
 */

export interface FileReference {
  /** The path as written, without its line suffix. */
  path: string;
  line?: number;
  column?: number;
}

export type FileTextSpan =
  | { kind: "text"; text: string }
  | { kind: "file"; text: string; reference: FileReference };

export type FileResolution =
  | { kind: "file"; path: string }
  | { kind: "ambiguous"; paths: readonly string[] }
  | { kind: "none" };

const segment = String.raw`[\w@+-][\w.@+-]*`;
const name = String.raw`[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`;
const lineSuffix = String.raw`(?::(\d{1,7})(?::(\d{1,5}))?|#L(\d{1,7})(?:C(\d{1,5}))?(?:-L?\d{1,7})?)?`;
const pathBody = String.raw`(?:\.{1,2}/|/)?(?:${segment}/)*${name}`;
const whole = new RegExp(String.raw`^(${pathBody})${lineSuffix}$`);
// In running text: not glued to a word, a path or a scheme on either side.
const inText = new RegExp(
  String.raw`(?<![\w/.@:~-])(${pathBody})${lineSuffix}(?![\w/@-]|\.\w|:\d)`,
  "g",
);

function reference(path: string, line?: string, column?: string): FileReference | undefined {
  if (path.includes("//") || /(?:^|\/)\.\.?$/.test(path)) return undefined;
  // An address, not a file: an email (`@` inside a segment) or a host (`example.com/...`).
  if (/[^/]@/.test(path) || /^[\w-]+(?:\.[\w-]+)+\//.test(path)) return undefined;
  const lineNumber = line ? Number(line) : undefined;
  const columnNumber = column ? Number(column) : undefined;
  return {
    path,
    ...(lineNumber ? { line: lineNumber } : {}),
    ...(lineNumber && columnNumber ? { column: columnNumber } : {}),
  };
}

/** The file an inline code span names, when the whole span is one file reference. */
export function codeFileReference(text: string): FileReference | undefined {
  const trimmed = text.trim();
  if (trimmed.length > 300 || /\s/.test(trimmed)) return undefined;
  const match = whole.exec(trimmed);
  if (!match?.[1]) return undefined;
  return reference(match[1], match[2] ?? match[4], match[3] ?? match[5]);
}

/**
 * Plain prose split around the file references it holds. Text without one comes back as a
 * single text span, so callers can keep the original string untouched.
 */
export function fileTextSpans(text: string): FileTextSpan[] {
  // Cheap gate: every reference has a dot followed by a letter.
  if (!/\.[A-Za-z]/.test(text)) return [{ kind: "text", text }];
  const spans: FileTextSpan[] = [];
  let at = 0;
  for (const match of text.matchAll(inText)) {
    const path = match[1];
    const line = match[2] ?? match[4];
    if (!path || (!path.includes("/") && !line)) continue;
    const found = reference(path, line, match[3] ?? match[5]);
    if (!found) continue;
    const start = match.index;
    if (start > at) spans.push({ kind: "text", text: text.slice(at, start) });
    spans.push({ kind: "file", text: match[0], reference: found });
    at = start + match[0].length;
  }
  if (at === 0) return [{ kind: "text", text }];
  if (at < text.length) spans.push({ kind: "text", text: text.slice(at) });
  return spans;
}

/** The workspace-relative form of `path`: `./` dropped, an absolute path under `root` cut. */
export function workspaceRelative(path: string, root: string | undefined): string | undefined {
  if (path.startsWith("/")) {
    const base = root?.replace(/\/+$/, "");
    return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined;
  }
  return path.replace(/^(?:\.\/)+/, "");
}

/**
 * Which checkout file `path` (workspace-relative) means among `candidates`: the exact path, else
 * the one path that ends with it. Two or more endings are ambiguous; none is none.
 */
export function resolveFileReference(path: string, candidates: readonly string[]): FileResolution {
  if (!path || path.startsWith("../")) return { kind: "none" };
  if (candidates.includes(path)) return { kind: "file", path };
  const matches = [...new Set(candidates.filter((candidate) => candidate.endsWith(`/${path}`)))];
  if (matches.length === 1 && matches[0]) return { kind: "file", path: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", paths: matches };
  return { kind: "none" };
}

/**
 * The local path a message's link names: a `file:` URL's path, or the target itself with any
 * `:line:col` suffix cut. Undefined for a web or other scheme's link, or a remote `file:` host.
 */
export function localLinkPath(target: string): string | undefined {
  try {
    if (target.startsWith("file:")) {
      const url = new URL(target);
      if (url.host && url.host !== "localhost") return;
      return decodeURIComponent(url.pathname);
    }
    return /^[a-z][a-z\d+.-]*:/i.test(target) ? undefined : target.replace(/:\d+(?::\d+)?$/, "");
  } catch {
    return;
  }
}

/** The line a link's `:line` or `:line:col` suffix names. */
export function localLinkLine(target: string): number | undefined {
  const match = /:(\d{1,7})(?::\d+)?$/.exec(target);
  return match?.[1] ? Number(match[1]) || undefined : undefined;
}

/** `path` with `.` and empty segments dropped and each `..` taking its folder away. */
export function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !path.startsWith("/")) parts.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + parts.join("/");
}

/**
 * Where a local link lands, relative to the thread's checkout `root`: a relative link resolves
 * from `cwd` (the answering agent's folder) or else the root. Undefined when it lands outside the
 * checkout, which only the daemon can serve (`link.download`).
 */
export function checkoutLinkPath(
  path: string,
  root: string | undefined,
  cwd: string | undefined,
): string | undefined {
  const base = (cwd ?? root)?.replace(/\/+$/, "");
  const absolute = normalizedPath(path.startsWith("/") || !base ? path : `${base}/${path}`);
  if (!absolute.startsWith("/")) return absolute;
  const top = root?.replace(/\/+$/, "");
  return top && absolute.startsWith(`${top}/`) ? absolute.slice(top.length + 1) : undefined;
}
