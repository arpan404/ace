import type { GitBlameCommit, GitBlameLine, GitLogEntry } from "@ace/protocol";
import { hashSchema } from "./decode.ts";

/*
 * Pure parsers for file-scoped `git log --follow --name-status -z` and
 * `git blame --porcelain`. Both tolerate output that stopped mid-record at the
 * daemon's byte cap, returning every complete entry before the cut.
 */

const recordSeparator = 0x1e;
const zeroHash = /^0{40,64}$/;

export interface ParsedFileLog {
  entries: GitLogEntry[];
  /** True when the input stopped at a byte cap before a record completed. */
  incomplete: boolean;
}

/**
 * Parse `git log --follow --name-status -z --format=tformat:%x1e%H%x00%an%x00%ae%x00%at%x00%s`.
 * `initialPath` is the repository-relative path asked for (used as fallback when a commit has no
 * name-status stanza, such as a merge).
 */
export function parseFileLog(
  stdout: Buffer,
  initialPath: string,
  truncated: boolean,
): ParsedFileLog {
  if (!stdout.length) return { entries: [], incomplete: truncated };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(stdout);
  const rawRecords = splitLogRecords(text);
  const completeCount = truncated ? Math.max(0, rawRecords.length - 1) : rawRecords.length;
  const entries: GitLogEntry[] = [];
  let currentPath = initialPath;
  let incomplete = truncated;

  for (let i = 0; i < completeCount; i++) {
    const raw = rawRecords[i];
    if (!raw) continue;
    const parsed = parseLogRecord(raw, currentPath);
    if (!parsed) {
      if (truncated) {
        incomplete = true;
        break;
      }
      continue;
    }
    entries.push(parsed.entry);
    currentPath = parsed.nextPath;
  }

  return { entries, incomplete };
}

function splitLogRecords(text: string): string[] {
  const records: string[] = [];
  let start = text.indexOf(String.fromCharCode(recordSeparator));
  while (start >= 0) {
    const next = text.indexOf(String.fromCharCode(recordSeparator), start + 1);
    records.push(next < 0 ? text.slice(start + 1) : text.slice(start + 1, next));
    start = next;
  }
  return records;
}

function parseLogRecord(
  raw: string,
  fallbackPath: string,
): { entry: GitLogEntry; nextPath: string } | undefined {
  const parts = raw.split("\0");
  // Expected: [sha, authorName, authorEmail, authorTimeSec, subject, ...nameStatus]
  if (parts.length < 5) return undefined;
  const sha = parts[0] ?? "";
  if (!hashSchema.safeParse(sha).success) return undefined;
  const authorName = (parts[1] ?? "").slice(0, 512);
  const authorEmail = (parts[2] ?? "").slice(0, 512);
  const seconds = Number(parts[3] ?? "");
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const authoredAt = Math.trunc(seconds) * 1000;
  const subject = (parts[4] ?? "").slice(0, 4096);

  let path = fallbackPath;
  let previousPath: string | undefined;
  let nextPath = fallbackPath;

  const statusToken = (parts[5] ?? "").replace(/^\r?\n/, "");
  if (statusToken) {
    const code = statusToken[0];
    if (code === "R" || code === "C") {
      const oldPath = parts[6];
      const newPath = parts[7];
      if (oldPath && newPath) {
        path = newPath;
        previousPath = oldPath;
        nextPath = oldPath;
      }
    } else if (parts[6]) {
      path = parts[6];
      nextPath = parts[6];
    }
  }

  return {
    entry: {
      sha,
      shortSha: sha.slice(0, 7),
      subject,
      authorName,
      authorEmail,
      authoredAt,
      path,
      ...(previousPath ? { previousPath } : {}),
    },
    nextPath,
  };
}

export interface ParsedFileBlame {
  commits: GitBlameCommit[];
  lines: GitBlameLine[];
  incomplete: boolean;
}

/**
 * Parse `git blame --porcelain` stdout. Each blamed line ends with a `\t<content>` line.
 * When `truncated` is true, any trailing incomplete block without its `\t` content line is dropped.
 */
export function parseFileBlame(
  stdout: Buffer,
  truncated: boolean,
  maxLines: number,
): ParsedFileBlame {
  if (!stdout.length) return { commits: [], lines: [], incomplete: truncated };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(stdout);
  const rawLines = text.split("\n");
  // When truncated mid-line, discard the unfinished last line so we never parse half a header.
  if (truncated && !text.endsWith("\n")) rawLines.pop();

  const commits = new Map<string, GitBlameCommit>();
  const lines: GitBlameLine[] = [];
  let incomplete = truncated;

  let currentSha: string | null | undefined;
  let currentLine: number | undefined;
  let meta: {
    authorName?: string;
    authorEmail?: string;
    authoredAt?: number;
    subject?: string;
    path?: string;
  } = {};

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index] ?? "";
    if (raw === "" && currentLine === undefined) continue;
    if (raw.startsWith("\t")) {
      if (currentLine !== undefined && currentSha !== undefined) {
        if (currentSha !== null && !commits.has(currentSha)) {
          commits.set(currentSha, {
            sha: currentSha,
            shortSha: currentSha.slice(0, 7),
            subject: (meta.subject ?? "").slice(0, 4096),
            authorName: (meta.authorName ?? "").slice(0, 512),
            authorEmail: (meta.authorEmail ?? "").slice(0, 512),
            authoredAt: meta.authoredAt ?? 0,
            ...(meta.path ? { path: meta.path } : {}),
          });
        }
        lines.push({ line: currentLine, sha: currentSha });
        currentSha = undefined;
        currentLine = undefined;
        meta = {};
        if (lines.length >= maxLines) {
          const hasMoreOutput = rawLines.slice(index + 1).some((line) => line.length > 0);
          if (hasMoreOutput) incomplete = true;
          break;
        }
        continue;
      }
      currentSha = undefined;
      currentLine = undefined;
      meta = {};
      continue;
    }

    if (currentLine === undefined) {
      const match = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/.exec(raw);
      if (!match) continue;
      const sha = match[1] ?? "";
      const finalLine = Number(match[3]);
      if (!Number.isSafeInteger(finalLine) || finalLine <= 0) continue;
      currentSha = zeroHash.test(sha) ? null : sha;
      currentLine = finalLine;
      meta = {};
      continue;
    }

    const space = raw.indexOf(" ");
    if (space < 0) continue;
    const key = raw.slice(0, space);
    const value = raw.slice(space + 1);
    if (key === "author") meta.authorName = value;
    else if (key === "author-mail") meta.authorEmail = stripAngleBrackets(value);
    else if (key === "author-time") {
      const sec = Number(value);
      if (Number.isFinite(sec) && sec >= 0) meta.authoredAt = Math.trunc(sec) * 1000;
    } else if (key === "summary") meta.subject = value;
    else if (key === "filename") meta.path = value;
  }

  return {
    commits: [...commits.values()],
    lines,
    incomplete: incomplete || currentLine !== undefined,
  };
}

function stripAngleBrackets(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}
