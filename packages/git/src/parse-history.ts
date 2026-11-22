import type { GitLogEntry } from "@ace/protocol";
import { hashSchema } from "./decode.ts";

/*
 * Pure parser for file-scoped `git log --follow --name-status -z`. It tolerates output that
 * stopped mid-record at the daemon's byte cap, returning every complete entry before the cut.
 */

const recordSeparator = 0x1e;

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
