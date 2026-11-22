import {
  gitBlameMaxBytes,
  gitBlameMaxLines,
  gitLogMaxBytes,
  gitLogMaxLimit,
  type GitBlameCommit,
  type GitBlameLine,
  type GitLogEntry,
} from "@ace/protocol";
import { devNull } from "node:os";
import { patchOutput, textOutput } from "./cli.ts";
import { hashSchema, pathSchema } from "./decode.ts";
import { parseFileBlame, parseFileLog } from "./parse-history.ts";
import type { Repository } from "./repository.ts";
import { GitError, type DiffResult } from "./types.ts";

/*
 * File history reads: a file's commits (`git log --follow`), blame of a line range at one
 * commit, and one commit's patch. Each is bounded twice: by output (Git is stopped once the
 * capture is full) and by work (Git is stopped after a time budget and what it wrote is kept).
 */

const emptyTreeSha1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const emptyTreeSha256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/** How long one history read may make Git work before it is stopped. */
export const historyBudgetMs = 10_000;
/** Blame reads the whole file at every commit it walks: larger files are refused. */
export const blameMaxFileBytes = 2 * 1024 * 1024;

/**
 * Where the next page of a file's history resumes: the same walk (`git log --follow` from `tip`
 * for `path` as named there) after the `shown` rows already shown, so merges keep both sides.
 */
export interface FileLogCursor {
  tip: string;
  path: string;
  shown: number;
}

/** The most rows a cursor may have shown: each page re-walks them (ids only), bounded. */
export const fileLogMaxShown = 10_000;

export interface FileLogOptions {
  worktree: string;
  path: string;
  cursor?: FileLogCursor | undefined;
  limit?: number | undefined;
  maxBytes?: number | undefined;
  budgetMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface FileLogResult {
  entries: GitLogEntry[];
  hasMore: boolean;
  next?: FileLogCursor;
  capped: boolean;
  head: string | null;
}

export interface FileBlameOptions {
  worktree: string;
  path: string;
  /** The commit to blame at; the result never depends on the working tree or a moving HEAD. */
  commit: string;
  startLine: number;
  endLine: number;
  maxBytes?: number | undefined;
  maxLines?: number | undefined;
  maxFileBytes?: number | undefined;
  budgetMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface FileBlameResult {
  head: string | null;
  commits: GitBlameCommit[];
  lines: GitBlameLine[];
  capped: boolean;
}

export interface CommitDiffOptions {
  worktree: string;
  commit: string;
  paths: readonly string[];
  maxPatchBytes: number;
  budgetMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

function validatePath(path: string): string {
  if (path.includes("\\"))
    throw new GitError("invalid_argument", `Invalid repository path: ${path}`);
  const parsed = pathSchema.safeParse(path);
  if (!parsed.success) throw new GitError("invalid_argument", `Invalid repository path: ${path}`);
  return parsed.data;
}

function validateCommit(commit: string): string {
  if (!hashSchema.safeParse(commit).success)
    throw new GitError("invalid_ref", `Invalid commit id: ${commit}`);
  return commit;
}

async function resolveHeadOrNull(
  repository: Repository,
  root: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return await repository.commit(root, "HEAD", signal);
  } catch (error) {
    if (error instanceof GitError && error.code === "unborn_head") return null;
    throw error;
  }
}

/** A commit's parents (none for a root commit). */
async function parentsOf(
  repository: Repository,
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const out = await repository.cli.call(root, ["rev-list", "--parents", "-n", "1", commit], {
    captureBytes: 64 * 1024,
    ...(signal ? { signal } : {}),
  });
  return textOutput(out).split(" ").slice(1).filter(Boolean);
}

/**
 * A file's commits following renames, a page at a time. The first page walks from HEAD; later
 * pages resume that same walk from the cursor's tip, past the rows shown. The walk itself asks
 * Git for ids and names only (a long subject before the page costs nothing); the page's own
 * commits are then read for their author and subject. A cursor whose tip Git no longer has is
 * refused (`history_changed`), never answered from another history.
 */
export async function fileLog(
  repository: Repository,
  root: string,
  options: Omit<FileLogOptions, "worktree">,
): Promise<FileLogResult> {
  const limit = options.limit ?? 50;
  const maxBytes = options.maxBytes ?? gitLogMaxBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > gitLogMaxLimit)
    throw new GitError("invalid_argument", `limit must be between 1 and ${gitLogMaxLimit}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new GitError("invalid_argument", "maxBytes must be a positive integer");
  const cursor = options.cursor;
  const path = validatePath(cursor?.path ?? options.path);
  const shown = cursor?.shown ?? 0;
  if (!Number.isSafeInteger(shown) || shown < 0 || shown > fileLogMaxShown)
    throw new GitError("invalid_argument", `shown must be between 0 and ${fileLogMaxShown}`);
  const { signal } = options;
  const budget = options.budgetMs ?? historyBudgetMs;

  const head = await resolveHeadOrNull(repository, root, signal);
  let tip: string;
  if (cursor) {
    tip = validateCommit(cursor.tip);
    const exists = await repository.cli.call(root, ["cat-file", "-e", `${tip}^{commit}`], {
      allowFailure: true,
      captureBytes: 64,
      ...(signal ? { signal } : {}),
    });
    if (exists.exitCode !== 0)
      throw new GitError("history_changed", "The history this page continues is gone");
  } else if (head) tip = head;
  else return { entries: [], hasMore: false, capped: false, head: null };

  // The walk: ids and the file's names, for every row up to the end of this page and one more.
  const rows = shown + limit + 1;
  const walk = await repository.cli.call(
    root,
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--follow",
      "--name-status",
      "-z",
      `--max-count=${rows}`,
      "--format=tformat:%x1e%H%x00%x00%x00%x00",
      tip,
      "--",
      `:(literal)${path}`,
    ],
    {
      captureBytes: 64 * 1024 + rows * (128 + 3 * Math.max(path.length, 64)),
      stopAtCapture: true,
      stopAfterMs: budget,
      ...(signal ? { signal } : {}),
    },
  );
  const walked = parseFileLog(walk.stdout, path, walk.truncated);
  const hasExtra = walked.entries.length > shown + limit;
  const page = walked.entries.slice(shown, shown + limit);
  let capped = walked.incomplete && !hasExtra;

  // The page's own commits, for their author, time and subject.
  const details = new Map<
    string,
    Pick<GitLogEntry, "authorName" | "authorEmail" | "authoredAt" | "subject">
  >();
  if (page.length) {
    const read = await repository.cli.call(
      root,
      [
        "show",
        "-s",
        "--no-notes",
        // The final NUL keeps tformat's line ending out of the subject.
        "--format=tformat:%x1e%H%x00%an%x00%ae%x00%at%x00%s%x00",
        ...page.map((entry) => entry.sha),
        "--",
      ],
      {
        captureBytes: maxBytes,
        stopAtCapture: true,
        stopAfterMs: budget,
        ...(signal ? { signal } : {}),
      },
    );
    for (const entry of parseFileLog(read.stdout, path, read.truncated).entries)
      details.set(entry.sha, entry);
  }
  const entries: GitLogEntry[] = [];
  for (const row of page) {
    const detail = details.get(row.sha);
    // A commit whose details did not fit: the page ends before it.
    if (!detail) {
      capped = true;
      break;
    }
    entries.push({
      ...row,
      authorName: detail.authorName,
      authorEmail: detail.authorEmail,
      authoredAt: detail.authoredAt,
      subject: detail.subject,
    });
  }
  const hasMore = entries.length < page.length || hasExtra || (capped && entries.length > 0);
  const next =
    hasMore && entries.length > 0 ? { tip, path, shown: shown + entries.length } : undefined;
  return { entries, hasMore, ...(next ? { next } : {}), capped, head };
}

/**
 * The blob `path` names in `commit`, or undefined when the commit (readable) has no file there.
 * A commit or tree Git cannot read is an error, never "no such file": that answer would be
 * shown, and kept, as lines not committed yet.
 */
async function blobAt(
  repository: Repository,
  root: string,
  commit: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const exists = await repository.cli.call(root, ["cat-file", "-e", `${commit}^{commit}`], {
    allowFailure: true,
    captureBytes: 64,
    ...(signal ? { signal } : {}),
  });
  if (exists.exitCode !== 0)
    throw new GitError("objects_not_available", `Git could not read commit ${commit}`);
  const listed = await repository.cli.call(
    root,
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", path],
    { allowFailure: true, captureBytes: 64 * 1024, ...(signal ? { signal } : {}) },
  );
  if (listed.exitCode !== 0)
    throw new GitError("objects_not_available", `Git could not read ${path} at ${commit}`);
  for (const record of listed.stdout.toString("utf8").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0 || record.slice(tab + 1) !== path) continue;
    const [, type, oid] = record.slice(0, tab).split(" ");
    return type === "blob" && oid ? oid : undefined;
  }
  return undefined;
}

/** The line count git names when a blame range starts or ends past the file's end. */
function linesInFile(stderr: string): number | undefined {
  const match = /has only (\d+) lines?/.exec(stderr);
  return match ? Number(match[1]) : undefined;
}

/**
 * Porcelain blame of an inclusive 1-based line range of `path` at `commit`. A file the commit
 * doesn't have, or a range starting past its end, returns no lines; a file over
 * `maxFileBytes` is refused (`file_too_large`), since blame reads it at every commit it walks.
 */
export async function fileBlame(
  repository: Repository,
  root: string,
  options: Omit<FileBlameOptions, "worktree">,
): Promise<FileBlameResult> {
  const path = validatePath(options.path);
  const commit = validateCommit(options.commit);
  const maxLines = Math.min(options.maxLines ?? gitBlameMaxLines, gitBlameMaxLines);
  const maxBytes = options.maxBytes ?? gitBlameMaxBytes;
  const maxFileBytes = options.maxFileBytes ?? blameMaxFileBytes;
  const { startLine, endLine, signal } = options;
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine - startLine + 1 > maxLines
  ) {
    throw new GitError("invalid_argument", `Blame line range must cover 1 to ${maxLines} lines`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new GitError("invalid_argument", "maxBytes must be a positive integer");
  const none: FileBlameResult = { head: commit, commits: [], lines: [], capped: false };

  const blob = await blobAt(repository, root, commit, path, signal);
  // The commit has no such file (untracked, or added since): an answer, not a failure.
  if (blob === undefined) return none;
  const size = await repository.cli.call(root, ["cat-file", "-s", blob], {
    allowFailure: true,
    captureBytes: 64,
    ...(signal ? { signal } : {}),
  });
  if (size.exitCode !== 0)
    throw new GitError("objects_not_available", `Git could not read ${path} at ${commit}`);
  if (Number(textOutput(size)) > maxFileBytes)
    throw new GitError("file_too_large", `${path} is too large to blame`);

  const blame = (end: number) =>
    repository.cli.call(
      root,
      [
        "-c",
        "core.quotePath=false",
        "blame",
        "--porcelain",
        "-L",
        `${startLine},${end}`,
        commit,
        "--",
        path,
      ],
      {
        allowFailure: true,
        captureBytes: maxBytes,
        stopAtCapture: true,
        stopAfterMs: options.budgetMs ?? historyBudgetMs,
        ...(signal ? { signal } : {}),
      },
    );

  let output = await blame(endLine);
  // The range reaches past the file's end: blame the lines that exist.
  const fileLines = output.exitCode === 0 ? undefined : linesInFile(output.stderr);
  if (fileLines !== undefined) {
    if (fileLines < startLine) return none;
    output = await blame(fileLines);
  }
  if (output.exitCode !== 0) {
    if (/no such path|outside repository/i.test(output.stderr)) return none;
    throw new GitError("git_failed", output.stderr.trim() || "git blame failed");
  }

  const parsed = parseFileBlame(output.stdout, output.truncated, maxLines);
  const asked = Math.min(endLine, fileLines ?? endLine) - startLine + 1;
  const capped = output.truncated || (parsed.incomplete && parsed.lines.length < asked);
  return { head: commit, commits: parsed.commits, lines: parsed.lines, capped };
}

/**
 * One commit's patch for `paths`, against its first parent (or the empty tree for a root
 * commit). Git is stopped once the patch reaches `maxPatchBytes` or the work budget runs out.
 */
export async function diffCommit(
  repository: Repository,
  root: string,
  options: Omit<CommitDiffOptions, "worktree">,
): Promise<DiffResult> {
  validateCommit(options.commit);
  if (!Number.isSafeInteger(options.maxPatchBytes) || options.maxPatchBytes < 0)
    throw new GitError("invalid_argument", "maxPatchBytes must be a non-negative integer");
  const paths = options.paths.map(validatePath);
  const { signal } = options;
  const sha = await repository.commit(root, options.commit, signal);
  const parents = await parentsOf(repository, root, sha, signal);
  const from = parents[0] ?? (sha.length === 64 ? emptyTreeSha256 : emptyTreeSha1);
  const orderFile = repository.cli.platform === "win32" ? "-O/dev/null" : `-O${devNull}`;
  const patch = await repository.cli.call(
    root,
    [
      "-c",
      "core.quotePath=true",
      "-c",
      "diff.suppressBlankEmpty=false",
      "diff",
      orderFile,
      "--no-relative",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--ignore-submodules=none",
      "--submodule=short",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "--find-renames=50%",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--line-prefix=",
      "--patch",
      "--unified=3",
      "--inter-hunk-context=0",
      from,
      sha,
      "--",
      ...paths.map((path) => `:(literal)${path}`),
    ],
    {
      captureBytes: options.maxPatchBytes,
      stopAtCapture: true,
      stopAfterMs: options.budgetMs ?? historyBudgetMs,
      ...(signal ? { signal } : {}),
    },
  );
  return {
    entries: [],
    patch: patchOutput({
      stdout: patch.stdout,
      truncated: patch.truncated,
      stderr: "",
      exitCode: 0,
    }),
    truncated: patch.truncated,
  };
}
