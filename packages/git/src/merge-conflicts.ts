import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  conflictFileLimit,
  maxConflictFileBytes,
  type GitConflictFile,
  type GitConflicts,
} from "@ace/protocol";
import { hasConflictHunks, parseConflictMarkers } from "./conflict-markers.ts";
import { longWriteTimeoutMs } from "./deadlines.ts";
import { nul } from "./decode.ts";
import type { Repository } from "./repository.ts";
import { within } from "./repository-paths.ts";
import { GitError } from "./types.ts";

const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const message = z.string().trim().min(1).max(65_536);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
/** Pathspecs name the file itself: `*.ts` or `:(glob)x` is that file. */
const literal = { GIT_LITERAL_PATHSPECS: "1" };
/** Everything a read's hunks may carry together, inside one wire frame. */
const readBudgetBytes = 6 * maxConflictFileBytes;

/** How a merge that started ended: conflicts to resolve, merged and staged, or nothing to do. */
export type MergeStart = "conflicts" | "merged" | "up_to_date";

/**
 * Merge `revision` into the checkout and stop before committing, conflicts or not. Refuses
 * when HEAD moved, a merge is already in progress, or tracked files have changes: the
 * person's own work is never mixed into a merge. Hunks are written in the diff3 style so each
 * one shows the merge base, and recorded resolutions (rerere) are not replayed silently.
 */
export async function startMerge(
  repository: Repository,
  options: { worktree: string; revision: string; expectedHead: string; message: string },
): Promise<MergeStart> {
  const target = commit.parse(options.revision);
  const expected = commit.parse(options.expectedHead);
  const text = message.parse(options.message);
  const root = await repository.root(options.worktree);
  return repository.serial(root, async () => {
    if (await merging(repository, root))
      throw new GitError("conflicts", "A merge is already in progress");
    const { branch, status } = await repository.state(root);
    if (branch.head !== expected) throw new GitError("head_moved", "HEAD moved; refresh first");
    if (status.conflicted.length || status.staged.length || status.unstaged.length)
      throw new GitError("dirty_worktree", "Commit or discard the checkout's changes first");
    const known = await repository.cli.call(
      root,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${target}^{commit}`],
      { allowFailure: true },
    );
    if (known.exitCode !== 0) throw new GitError("invalid_ref", "The base isn't in this checkout");
    const merged = await repository.cli.call(
      root,
      [
        "-c",
        "merge.conflictStyle=diff3",
        "-c",
        "rerere.enabled=false",
        "merge",
        "--no-commit",
        "--no-ff",
        "--no-edit",
        "-m",
        text,
        "--end-of-options",
        target,
      ],
      {
        write: true,
        allowFailure: true,
        timeoutMs: longWriteTimeoutMs,
        env: { GIT_MERGE_AUTOEDIT: "no", GIT_EDITOR: "true" },
      },
    );
    if (await merging(repository, root))
      return (await repository.status(root)).conflicted.length ? "conflicts" : "merged";
    if (merged.exitCode === 0) return "up_to_date";
    // Git refused before touching anything: an untracked file is where the merge writes one.
    throw new GitError(
      "dirty_worktree",
      "Git couldn't start the merge: move untracked files it would overwrite",
    );
  });
}

/** `git merge --abort`: the checkout goes back to HEAD as it was before the merge. */
export async function abortMerge(repository: Repository, worktree: string): Promise<void> {
  const root = await repository.root(worktree);
  await repository.serial(root, async () => {
    if (!(await merging(repository, root)))
      throw new GitError("invalid_argument", "No merge is in progress");
    await repository.cli.call(root, ["merge", "--abort"], {
      write: true,
      timeoutMs: longWriteTimeoutMs,
    });
  });
}

/** The checkout's merge state and every unmerged path, each with its hunks when it's text. */
export async function readConflicts(repository: Repository, worktree: string) {
  const root = await repository.root(worktree);
  return repository.serial(root, async (): Promise<GitConflicts> => {
    const [{ branch, status }, inMerge, unmerged] = await Promise.all([
      repository.state(root),
      merging(repository, root),
      unmergedPaths(repository, root),
    ]);
    const paths = [...unmerged.keys()].toSorted();
    const files: GitConflictFile[] = [];
    let budget = readBudgetBytes;
    for (const name of paths.slice(0, conflictFileLimit)) {
      const read = await workingText(root, name, budget);
      budget -= read.bytes;
      files.push({ path: name, stages: unmerged.get(name) ?? noStages, content: read.content });
    }
    return {
      head: branch.head,
      merging: inMerge,
      dirty:
        !inMerge && !!(status.conflicted.length || status.staged.length || status.unstaged.length),
      files,
      truncated: paths.length > conflictFileLimit,
    };
  });
}

/**
 * Write an unmerged file's resolved text, unless it changed since `revision` was read. It's
 * staged once no conflict hunk is left; until then the remaining hunks stay to resolve.
 */
export async function writeResolution(
  repository: Repository,
  options: { worktree: string; path: string; content: string; revision: string },
): Promise<{ staged: boolean }> {
  const name = path.parse(options.path);
  const expected = revision.parse(options.revision);
  if (Buffer.byteLength(options.content) > maxConflictFileBytes)
    throw new GitError("invalid_argument", "The resolution is too large to write here");
  const root = await repository.root(options.worktree);
  return repository.serial(root, async () => {
    await assertUnmerged(repository, root, name);
    const file = await regularFile(root, name);
    if (!file || digest(await readFile(file)) !== expected)
      throw new GitError("head_moved", `${name} changed since it was read; refresh first`);
    await writeFile(file, options.content);
    if (hasConflictHunks(options.content)) return { staged: false };
    await stage(repository, root, ["add", "--", name]);
    return { staged: true };
  });
}

/** Resolve a path to one side's whole version, or its deletion when that side deleted it. */
export async function takeSide(
  repository: Repository,
  options: { worktree: string; path: string; side: "ours" | "theirs" },
): Promise<void> {
  const name = path.parse(options.path);
  const root = await repository.root(options.worktree);
  await repository.serial(root, async () => {
    const stages = await assertUnmerged(repository, root, name);
    if (!stages[options.side]) {
      await stage(repository, root, ["rm", "--quiet", "--force", "--", name]);
      return;
    }
    await stage(repository, root, ["checkout", `--${options.side}`, "--", name]);
    await stage(repository, root, ["add", "--", name]);
  });
}

/**
 * Commit the merge in progress with exactly what is staged and the message `startMerge` gave. Unstaged edits made meanwhile
 * stay where they are; nothing new is added. Returns the merge commit.
 */
export async function commitMerge(
  repository: Repository,
  options: { worktree: string; expectedHead: string },
): Promise<string> {
  const expected = commit.parse(options.expectedHead);
  // ace's own reads keep the checkout's protections; only `commit` is the person's.
  const read = <T>(operation: () => Promise<T>) => repository.cli.bookkeeping(operation);
  const root = await read(() => repository.root(options.worktree));
  return repository.serial(root, async () => {
    const { branch, status } = await read(() => repository.state(root));
    if (branch.head !== expected) throw new GitError("head_moved", "HEAD moved; refresh first");
    if (!(await read(() => merging(repository, root))))
      throw new GitError("invalid_argument", "No merge is in progress");
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve every conflicted file first");
    // The message the merge prepared, without the `# Conflicts:` notes Git appends to it.
    await repository.cli.call(root, ["commit", "--no-edit", "--cleanup=strip"], {
      write: true,
      timeoutMs: longWriteTimeoutMs,
      captureBytes: 65_536,
      env: { GIT_TRACE2_EVENT: "1" },
    });
    return commit.parse(await read(() => repository.commit(root, "HEAD")));
  });
}

const noStages = { base: false, ours: false, theirs: false };

async function merging(repository: Repository, root: string): Promise<boolean> {
  const head = await repository.cli.call(
    root,
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD^{commit}"],
    { allowFailure: true },
  );
  return head.exitCode === 0;
}

/** `git ls-files -u`: each unmerged path with the stages (1 base, 2 ours, 3 theirs) it has. */
async function unmergedPaths(repository: Repository, root: string, only?: string) {
  const listed = await repository.cli.call(
    root,
    ["ls-files", "--unmerged", "-z", ...(only ? ["--", only] : [])],
    { captureBytes: 8 * 1_048_576, ...(only ? { env: literal } : {}) },
  );
  if (listed.truncated) throw new GitError("output_too_large", "Too many conflicted files");
  const paths = new Map<string, { base: boolean; ours: boolean; theirs: boolean }>();
  for (const record of nul(listed.stdout)) {
    const match = /^\d+ [a-f0-9]+ ([123])\t(.+)$/s.exec(record);
    if (!match?.[2]) throw new GitError("malformed_output", "Unreadable unmerged entry");
    const stages = paths.get(match[2]) ?? { ...noStages };
    stages[match[1] === "1" ? "base" : match[1] === "2" ? "ours" : "theirs"] = true;
    paths.set(match[2], stages);
  }
  return paths;
}

async function assertUnmerged(repository: Repository, root: string, name: string) {
  if (!(await merging(repository, root)))
    throw new GitError("invalid_argument", "No merge is in progress");
  const stages = (await unmergedPaths(repository, root, name)).get(name);
  if (!stages) throw new GitError("invalid_argument", `${name} has no conflict to resolve`);
  return stages;
}

function stage(repository: Repository, root: string, args: string[]) {
  return repository.cli.call(root, args, {
    write: true,
    timeoutMs: longWriteTimeoutMs,
    env: literal,
  });
}

/** The path inside the checkout when it's a regular file there (no symlink on the way out). */
async function regularFile(root: string, name: string): Promise<string | undefined> {
  const file = join(root, name);
  try {
    if (!within(root, await realpath(dirname(file)))) return undefined;
    return (await lstat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

const unavailable = (reason: "binary" | "too_large" | "missing" | "unsupported") => ({
  content: { kind: "unavailable" as const, reason },
  bytes: 0,
});

async function workingText(
  root: string,
  name: string,
  budget: number,
): Promise<{ content: GitConflictFile["content"]; bytes: number }> {
  const file = join(root, name);
  let stats;
  try {
    stats = await lstat(file);
  } catch {
    return unavailable("missing");
  }
  if (!(await regularFile(root, name))) return unavailable("unsupported");
  if (stats.size > Math.min(maxConflictFileBytes, budget)) return unavailable("too_large");
  const bytes = await readFile(file);
  if (bytes.length > Math.min(maxConflictFileBytes, budget)) return unavailable("too_large");
  if (bytes.includes(0) || !isUtf8(bytes)) return unavailable("binary");
  return {
    content: {
      kind: "text",
      revision: digest(bytes),
      segments: parseConflictMarkers(bytes.toString("utf8")),
    },
    bytes: bytes.length,
  };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
