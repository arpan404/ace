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

/** Where the next page of a file's history starts: before `after`, at the file's name there. */
export interface FileLogCursor {
  after: string;
  path: string;
}

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
 * A file's commits following renames, a page at a time. The first page starts at HEAD; each
 * later one at the cursor the page before returned (before its last commit, at the file's name
 * there), so a page never replays the ones before it and new commits never shift it.
 */
export async function fileLog(
  repository: Repository,
  root: string,
  options: Omit<FileLogOptions, "worktree">,
): Promise<FileLogResult> {
  const path = validatePath(options.path);
  const limit = options.limit ?? 50;
  const maxBytes = options.maxBytes ?? gitLogMaxBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > gitLogMaxLimit)
    throw new GitError("invalid_argument", `limit must be between 1 and ${gitLogMaxLimit}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new GitError("invalid_argument", "maxBytes must be a positive integer");
  const cursor = options.cursor && {
    after: validateCommit(options.cursor.after),
    path: validatePath(options.cursor.path),
  };

  const head = await resolveHeadOrNull(repository, root, options.signal);
  if (!head) return { entries: [], hasMore: false, capped: false, head: null };
  const starts = cursor ? await parentsOf(repository, root, cursor.after, options.signal) : [head];
  if (starts.length === 0) return { entries: [], hasMore: false, capped: false, head };
  const walkPath = cursor?.path ?? path;

  const output = await repository.cli.call(
    root,
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--follow",
      "--name-status",
      "-z",
      `--max-count=${limit + 1}`,
      "--format=tformat:%x1e%H%x00%an%x00%ae%x00%at%x00%s",
      ...starts,
      "--",
      `:(literal)${walkPath}`,
    ],
    {
      captureBytes: maxBytes,
      stopAtCapture: true,
      stopAfterMs: options.budgetMs ?? historyBudgetMs,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  const parsed = parseFileLog(output.stdout, walkPath, output.truncated);
  const hasExtra = parsed.entries.length > limit;
  const entries = hasExtra ? parsed.entries.slice(0, limit) : parsed.entries;
  const capped = parsed.incomplete && !hasExtra;
  const hasMore = hasExtra || (capped && entries.length > 0);
  const last = entries.at(-1);
  const next =
    hasMore && last ? { after: last.sha, path: last.previousPath ?? last.path } : undefined;
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
