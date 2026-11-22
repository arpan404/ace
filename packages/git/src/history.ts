import { gitLogMaxBytes, gitLogMaxLimit, type GitLogEntry } from "@ace/protocol";
import { devNull } from "node:os";
import { patchOutput, textOutput } from "./cli.ts";
import { hashSchema, pathSchema } from "./decode.ts";
import { logFormat, parseFileLog } from "./parse-history.ts";
import type { Repository } from "./repository.ts";
import { GitError, type DiffResult } from "./types.ts";

/*
 * File history reads: a file's commits (`git log --follow`) and one commit's patch. Each is bounded twice: by output (Git is stopped once the
 * capture is full) and by work (Git is stopped after a time budget and what it wrote is kept).
 */

const emptyTreeSha1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const emptyTreeSha256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/** How long one history read may make Git work before it is stopped. */
export const historyBudgetMs = 10_000;

export interface FileLogOptions {
  worktree: string;
  path: string;
  limit?: number | undefined;
  maxBytes?: number | undefined;
  budgetMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface FileLogResult {
  entries: GitLogEntry[];
  /**
   * Why the list ends before the file's first commit: `limit` (the newest `limit` commits, or
   * the byte cap), `budget` (the walk ran out of time). Absent when it is the whole history.
   */
  stopped?: "limit" | "budget";
  head: string | null;
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
 * A file's newest commits following renames (`git log --follow -n limit` from HEAD), in one
 * walk bounded by the byte cap and the work budget. There are no later pages: what is older
 * than the list is for `git log` itself, and the result says why the list stopped.
 */
export async function fileLog(
  repository: Repository,
  root: string,
  options: Omit<FileLogOptions, "worktree">,
): Promise<FileLogResult> {
  const path = validatePath(options.path);
  const limit = options.limit ?? gitLogMaxLimit;
  const maxBytes = options.maxBytes ?? gitLogMaxBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > gitLogMaxLimit)
    throw new GitError("invalid_argument", `limit must be between 1 and ${gitLogMaxLimit}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new GitError("invalid_argument", "maxBytes must be a positive integer");
  const { signal } = options;
  const head = await resolveHeadOrNull(repository, root, signal);
  if (!head) return { entries: [], head: null };

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
      `--format=${logFormat}`,
      head,
      "--",
      `:(literal)${path}`,
    ],
    {
      captureBytes: maxBytes,
      stopAtCapture: true,
      stopAfterMs: options.budgetMs ?? historyBudgetMs,
      ...(signal ? { signal } : {}),
    },
  );
  const parsed = parseFileLog(output.stdout, path, output.truncated);
  const entries = parsed.entries.slice(0, limit);
  const stopped =
    output.stopped === "budget"
      ? "budget"
      : parsed.entries.length > limit || parsed.incomplete
        ? "limit"
        : undefined;
  return { entries, ...(stopped ? { stopped } : {}), head };
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
