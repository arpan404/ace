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
import { diff } from "./diff.ts";
import { parseFileBlame, parseFileLog } from "./parse-history.ts";
import type { Repository } from "./repository.ts";
import { GitError, type DiffResult } from "./types.ts";

const emptyTreeSha1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const emptyTreeSha256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

export interface FileLogOptions {
  worktree: string;
  path: string;
  skip?: number | undefined;
  limit?: number | undefined;
  maxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface FileLogResult {
  entries: GitLogEntry[];
  hasMore: boolean;
  nextSkip?: number;
  capped: boolean;
  head: string | null;
}

export interface FileBlameOptions {
  worktree: string;
  path: string;
  startLine: number;
  endLine: number;
  maxBytes?: number | undefined;
  maxLines?: number | undefined;
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
}

function validatePath(path: string): string {
  if (path.includes("\\"))
    throw new GitError("invalid_argument", `Invalid repository path: ${path}`);
  const parsed = pathSchema.safeParse(path);
  if (!parsed.success) throw new GitError("invalid_argument", `Invalid repository path: ${path}`);
  return parsed.data;
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

/**
 * File-scoped commit history following renames, bounded by entry limit and byte cap.
 */
export async function fileLog(
  repository: Repository,
  root: string,
  options: Omit<FileLogOptions, "worktree">,
): Promise<FileLogResult> {
  const path = validatePath(options.path);
  const skip = options.skip ?? 0;
  const limit = options.limit ?? 50;
  const maxBytes = options.maxBytes ?? gitLogMaxBytes;
  if (!Number.isSafeInteger(skip) || skip < 0 || skip > 100_000)
    throw new GitError("invalid_argument", "skip must be an integer between 0 and 100000");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > gitLogMaxLimit)
    throw new GitError("invalid_argument", `limit must be between 1 and ${gitLogMaxLimit}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new GitError("invalid_argument", "maxBytes must be a positive integer");

  const head = await resolveHeadOrNull(repository, root, options.signal);
  if (!head) return { entries: [], hasMore: false, capped: false, head: null };

  // `git log --follow` only detects renames at commits it inspects; `--skip` would jump past
  // a rename before switching paths. Bound the walk to `skip + limit + 1` and slice the page.
  const captureLimit = skip === 0 ? maxBytes : Math.min(4 * 1024 * 1024, maxBytes + skip * 512);
  const output = await repository.cli.call(
    root,
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--follow",
      "--name-status",
      "-z",
      `--max-count=${skip + limit + 1}`,
      "--format=tformat:%x1e%H%x00%an%x00%ae%x00%at%x00%s",
      head,
      "--",
      `:(literal)${path}`,
    ],
    {
      captureBytes: captureLimit,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  const parsed = parseFileLog(output.stdout, path, output.truncated);
  const afterSkip = parsed.entries.slice(skip);
  const hasExtra = afterSkip.length > limit;
  const entries = hasExtra ? afterSkip.slice(0, limit) : afterSkip;
  const capped = parsed.incomplete && !hasExtra;
  const hasMore = hasExtra || (capped && entries.length > 0);
  const nextSkip = hasMore ? skip + entries.length : undefined;

  return {
    entries,
    hasMore,
    ...(nextSkip !== undefined ? { nextSkip } : {}),
    capped,
    head,
  };
}

/**
 * File-scoped porcelain blame over an inclusive 1-based line range, bounded by line and byte caps.
 * Untracked files, unborn HEAD, or ranges starting past EOF return an empty line list cleanly.
 */
export async function fileBlame(
  repository: Repository,
  root: string,
  options: Omit<FileBlameOptions, "worktree">,
): Promise<FileBlameResult> {
  const path = validatePath(options.path);
  const maxLines = Math.min(options.maxLines ?? gitBlameMaxLines, gitBlameMaxLines);
  const maxBytes = options.maxBytes ?? gitBlameMaxBytes;
  const { startLine, endLine } = options;
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

  const head = await resolveHeadOrNull(repository, root, options.signal);
  if (!head) return { head: null, commits: [], lines: [], capped: false };

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
        "--",
        path,
      ],
      {
        allowFailure: true,
        captureBytes: maxBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

  let output = await blame(endLine);
  // The range reaches past the file's end on disk (an unsaved buffer can be longer): blame the
  // lines that exist instead of failing the whole range.
  const fileLines = output.exitCode === 0 ? undefined : linesInFile(output.stderr);
  if (fileLines !== undefined) {
    if (fileLines < startLine) return { head, commits: [], lines: [], capped: false };
    output = await blame(fileLines);
  }

  if (output.exitCode !== 0) {
    const stderr = output.stderr.toLowerCase();
    // An untracked file or one outside the repository has no history: not an error.
    if (stderr.includes("no such path") || stderr.includes("outside repository")) {
      return { head, commits: [], lines: [], capped: false };
    }
    throw new GitError("git_failed", output.stderr.trim() || "git blame failed");
  }

  const parsed = parseFileBlame(output.stdout, output.truncated, maxLines);
  const expectedMax = endLine - startLine + 1;
  const capped = output.truncated || (parsed.incomplete && parsed.lines.length < expectedMax);

  return {
    head,
    commits: parsed.commits,
    lines: parsed.lines,
    capped,
  };
}

/** The line count git names when a blame range starts or ends past the file's end. */
function linesInFile(stderr: string): number | undefined {
  const match = /has only (\d+) lines?/.exec(stderr);
  return match ? Number(match[1]) : undefined;
}

/**
 * Diff a single commit against its first parent (or the empty tree for a root commit),
 * scoped to `paths`.
 */
export async function diffCommit(
  repository: Repository,
  root: string,
  options: Omit<CommitDiffOptions, "worktree">,
): Promise<DiffResult> {
  if (!hashSchema.safeParse(options.commit).success)
    throw new GitError("invalid_ref", `Invalid commit id: ${options.commit}`);
  if (!Number.isSafeInteger(options.maxPatchBytes) || options.maxPatchBytes < 0)
    throw new GitError("invalid_argument", "maxPatchBytes must be a non-negative integer");
  const paths = options.paths.map(validatePath);
  const sha = await repository.commit(root, options.commit);

  const parent = await repository.cli.call(root, ["rev-parse", "--verify", "--quiet", `${sha}^1`], {
    allowFailure: true,
  });
  if (parent.exitCode === 0) {
    const parentSha = textOutput(parent);
    return diff(
      repository,
      root,
      { kind: "commit", ref: parentSha },
      { kind: "commit", ref: sha },
      options.maxPatchBytes,
      paths,
    );
  }

  // Root commit has no parent: diff against Git's empty tree object.
  const emptyTree = sha.length === 64 ? emptyTreeSha256 : emptyTreeSha1;
  const pathspecs = paths.map((path) => `:(literal)${path}`);
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
      emptyTree,
      sha,
      "--",
      ...pathspecs,
    ],
    { captureBytes: options.maxPatchBytes },
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
