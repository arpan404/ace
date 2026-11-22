import type { GitLogEntry } from "@ace/protocol";
import { hashSchema } from "./decode.ts";

/*
 * Pure parser for file-scoped `git log --follow --name-status -z` with the format
 * `logFormat`. Every field ends in NUL and is read by count, never by searching for a separator
 * byte, so a subject or file name may hold any byte but NUL (which Git can't store in either).
 * It tolerates output that stopped mid-record at the daemon's byte cap, returning every
 * complete entry before the cut.
 */

/** The `--format` this parser reads: five NUL-ended fields per commit. */
export const logFormat = "tformat:%H%x00%an%x00%ae%x00%at%x00%s%x00";

export interface ParsedFileLog {
  entries: GitLogEntry[];
  /** True when the input stopped at a byte cap before a record completed. */
  incomplete: boolean;
}

/** A name-status code: one letter, a similarity score for renames and copies. */
const statusCode = /^[A-Z][0-9]{0,3}$/;

/**
 * Parse `git log --follow --name-status -z --format=<logFormat>`. Per commit, the tokens are:
 * id, author, email, author time, subject, an empty one (`-z`'s record end), then, when the
 * commit changed the file, a status (after a newline) and one path, or two for a rename or copy.
 * `initialPath` is the path asked for: a commit with no status keeps the path it had.
 */
export function parseFileLog(
  stdout: Buffer,
  initialPath: string,
  truncated: boolean,
): ParsedFileLog {
  if (!stdout.length) return { entries: [], incomplete: truncated };
  const tokens = new TextDecoder("utf-8", { fatal: false }).decode(stdout).split("\0");
  // The last token is what followed the last NUL: empty when whole, possibly cut when capped.
  tokens.pop();
  const entries: GitLogEntry[] = [];
  let path = initialPath;
  let at = 0;
  while (at < tokens.length) {
    const sha = stripNewline(tokens[at] ?? "");
    if (!hashSchema.safeParse(sha).success) return { entries, incomplete: true };
    const fields = tokens.slice(at + 1, at + 6);
    if (fields.length < 5 || fields[4] !== "") return { entries, incomplete: true };
    const [authorName = "", authorEmail = "", seconds = "", subject = ""] = fields;
    const time = Number(seconds);
    if (!Number.isFinite(time) || time < 0) return { entries, incomplete: true };
    let next = at + 6;
    let previousPath: string | undefined;
    let nextPath = path;
    const status = tokens[next];
    if (status !== undefined && statusCode.test(stripNewline(status))) {
      const code = stripNewline(status);
      const two = code.startsWith("R") || code.startsWith("C");
      const names = tokens.slice(next + 1, next + (two ? 3 : 2));
      if (names.length < (two ? 2 : 1)) return { entries, incomplete: true };
      if (two) {
        previousPath = names[0];
        path = names[1] ?? path;
        nextPath = names[0] ?? path;
      } else {
        path = names[0] ?? path;
        nextPath = path;
      }
      next += two ? 3 : 2;
    } else if (status === undefined && truncated) {
      // Cut right after the header: the status that may follow is unknown.
      return { entries, incomplete: true };
    }
    entries.push({
      sha,
      shortSha: sha.slice(0, 7),
      subject: subject.slice(0, 4096),
      authorName: authorName.slice(0, 512),
      authorEmail: authorEmail.slice(0, 512),
      authoredAt: Math.trunc(time) * 1000,
      path,
      ...(previousPath ? { previousPath } : {}),
    });
    path = nextPath;
    at = next;
  }
  return { entries, incomplete: truncated };
}

function stripNewline(token: string): string {
  return token.replace(/^\r?\n/, "");
}
