import { countChanges, parseUnifiedDiff } from "./diff.ts";
import type { FileDiff } from "./turns.ts";

/*
 * A `git diff` patch (many files, with git's headers) read file by file. Pure and linear in the
 * patch: each file's section is a slice of it, scanned once for its header and once for its rows.
 */

/** One file's part of a patch. */
export interface PatchSection {
  /** The file's path: the new one, or the old one for a deletion. */
  path: string;
  /** A rename's old path. */
  from?: string | undefined;
  status: FileDiff["status"];
  /** Git said the content is binary, so there are no line changes to show. */
  binary: boolean;
  /** The section's text, from its `diff --git` line to the next one. */
  text: string;
}

const headerName = /^(?:---|\+\+\+) /;

/** Git's C-style quoting (`"a/sp\303\251cial"`), undone; unquoted paths pass through. */
export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  const body = path.slice(1, -1);
  for (let at = 0; at < body.length; at++) {
    const code = body.codePointAt(at) ?? 0;
    if (code !== 0x5c) {
      bytes.push(...utf8(code));
      if (code > 0xffff) at++;
      continue;
    }
    const next = body[at + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(at + 1, at + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      at += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      at += 1;
    }
  }
  return fromUtf8(bytes);
}

function utf8(code: number): number[] {
  if (code < 0x80) return [code];
  if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 63)];
  if (code < 0x10000) return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 63),
    0x80 | ((code >> 6) & 63),
    0x80 | (code & 63),
  ];
}

/** UTF-8 bytes to text without platform decoders (the native bridges run plain JS). */
function fromUtf8(bytes: readonly number[]): string {
  let out = "";
  for (let at = 0; at < bytes.length;) {
    const lead = bytes[at] ?? 0;
    const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    let code = size === 1 ? lead : lead & (0xff >> (size + 1));
    for (let index = 1; index < size; index++) code = (code << 6) | ((bytes[at + index] ?? 0) & 63);
    out += String.fromCodePoint(code);
    at += size;
  }
  return out;
}

/** The path a `---`/`+++` line names, without its `a/`/`b/` prefix; undefined for /dev/null. */
function namedPath(line: string): string | undefined {
  const raw = unquoteGitPath(line.slice(4).split("\t")[0]?.trim() ?? "");
  return raw === "/dev/null" ? undefined : raw.replace(/^[ab]\//, "");
}

/** The new path of a `diff --git a/X b/Y` line, for sections without `---`/`+++` lines. */
function gitLinePath(line: string): string | undefined {
  const rest = line.slice("diff --git ".length);
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted?.[1]) return unquoteGitPath(quoted[1]).replace(/^b\//, "");
  // Unquoted paths may hold spaces; an unchanged path is the line's two equal halves.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
    return rest.slice(half + 3);
  }
  return /^a\/.+ b\/(.+)$/.exec(rest)?.[1];
}

function sectionOf(text: string): PatchSection | undefined {
  let path: string | undefined;
  let removed: string | undefined;
  let renamedTo: string | undefined;
  let from: string | undefined;
  let status: FileDiff["status"] = "modified";
  let binary = false;
  let end = text.indexOf("\n");
  const first = text.slice(0, end < 0 ? text.length : end);
  // The header ends at the first hunk; reading line by line stops there.
  for (let start = end + 1; end >= 0 && start < text.length; start = end + 1) {
    end = text.indexOf("\n", start);
    const line = text.slice(start, end < 0 ? text.length : end);
    if (line.startsWith("@@")) break;
    if (headerName.test(line)) {
      if (line.startsWith("+++ ")) path = namedPath(line);
      else removed = namedPath(line);
    } else if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from ")) from = unquoteGitPath(line.slice(12));
    else if (line.startsWith("rename to ")) renamedTo = unquoteGitPath(line.slice(10));
    else if (line.startsWith("copy to ")) {
      renamedTo = unquoteGitPath(line.slice(8));
      status = "added";
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))
      binary = true;
  }
  const named = path ?? removed ?? renamedTo ?? gitLinePath(first);
  if (!named) return undefined;
  if (from !== undefined && status === "modified") status = "moved";
  return { path: named, from: status === "moved" ? from : undefined, status, binary, text };
}

/** A patch's file sections in order, each path once (the first section for it wins). */
export function patchSections(patch: string): PatchSection[] {
  const starts: number[] = [];
  if (patch.startsWith("diff --git ")) starts.push(0);
  for (
    let at = patch.indexOf("\ndiff --git ");
    at !== -1;
    at = patch.indexOf("\ndiff --git ", at + 1)
  )
    starts.push(at + 1);
  const seen = new Set<string>();
  const sections: PatchSection[] = [];
  starts.forEach((start, index) => {
    const section = sectionOf(patch.slice(start, starts[index + 1] ?? patch.length));
    if (!section || seen.has(section.path)) return;
    seen.add(section.path);
    sections.push(section);
  });
  return sections;
}

/**
 * Each file of a `git diff` patch as the diff view's rows: added and removed lines with their
 * old and new numbers, gaps between hunks as folds of known size. A binary file or a mode change
 * has no rows. A patch cut short (the daemon caps it) ends with the rows it has.
 */
export function gitPatchFiles(patch: string): FileDiff[] {
  return patchSections(patch).map((section): FileDiff => {
    // The section's final newline ends its last line; it isn't an empty line of a cut hunk.
    const text = section.text.endsWith("\n") ? section.text.slice(0, -1) : section.text;
    const rows = section.binary ? [] : parseUnifiedDiff(text);
    const { additions, deletions } = countChanges(rows);
    const file: FileDiff = {
      path: section.path,
      status: section.status,
      rows,
      additions,
      deletions,
    };
    if (section.from !== undefined) file.movedFrom = section.from;
    return file;
  });
}
