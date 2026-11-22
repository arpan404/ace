import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { longWriteTimeoutMs } from "./deadlines.ts";
import { GitDiagnostics } from "./diagnostics.ts";
import { failureMessage } from "./failure-text.ts";
import { remoteNames } from "./remote-branches.ts";
import type { Repository } from "./repository.ts";
import { excludeAcePrivate, personPathspecs } from "./ace-private.ts";

import { GitError } from "./types.ts";

const maxPathBytes = 256 * 1024;
const maxPaths = 1000;
const literalEnv = { GIT_LITERAL_PATHSPECS: "1" };

const remoteName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w./-]+$/)
  .refine((value) => !value.startsWith("-"));

/**
 * Validate repository-relative paths so none escape `root`, target `.git`, or pass empty/NUL
 * pathspecs to Git. Pure: operates on strings and `path.resolve`/`relative`.
 */
export function validateRepoPaths(root: string, paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > maxPaths)
    throw new GitError("invalid_argument", `Name between 1 and ${maxPaths} paths`);
  let totalBytes = 0;
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const raw of paths) {
    if (!raw || raw.length > 4096 || raw.includes("\0"))
      throw new GitError("path_outside_repo", "Path is invalid or contains NUL bytes");
    if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw) || isAbsolute(raw)) {
      throw new GitError("path_outside_repo", "Absolute paths are not allowed");
    }
    const segments = raw.split(/[/\\]/);
    if (
      segments.some((segment) => segment === "..") ||
      segments[0]?.toLowerCase() === ".git" ||
      segments.some((segment) => segment.toLowerCase() === ".git") ||
      raw === "."
    ) {
      throw new GitError("path_outside_repo", "Path escapes the repository or targets .git");
    }
    const target = resolve(root, raw);
    const rel = relative(root, target);
    if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel))
      throw new GitError("path_outside_repo", "Path escapes the repository root");
    totalBytes += Buffer.byteLength(raw) + 1;
    if (totalBytes > maxPathBytes)
      throw new GitError("invalid_argument", "Total pathspec length exceeds limit");
    if (!seen.has(raw)) {
      seen.add(raw);
      valid.push(raw);
    }
  }
  return valid;
}

/** Stage specified paths, or every change in the checkout when `paths` is omitted. */
export async function stagePaths(
  repository: Repository,
  options: { worktree: string; paths?: readonly string[] | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const paths = options.paths ? validateRepoPaths(root, options.paths) : undefined;
  await repository.serial(root, async () => {
    await excludeAcePrivate(repository, root);
    // A folder or Stage all never takes ace's own `.ace-upload-*` entries (uploads, Recently
    // deleted), even inside the folder.
    await repository.cli.call(
      root,
      ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
      {
        write: true,
        timeoutMs: longWriteTimeoutMs,
        captureBytes: 65_536,
        input: `${personPathspecs(paths ?? ["."]).join("\0")}\0`,
      },
    );
  });
}

/** Unstage specified paths, or every staged change when `paths` is omitted. */
export async function unstagePaths(
  repository: Repository,
  options: { worktree: string; paths?: readonly string[] | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const paths = options.paths ? validateRepoPaths(root, options.paths) : undefined;
  await repository.serial(root, async () => {
    const info = await repository.info(root);
    if (info.head === null) {
      const args = paths
        ? ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths]
        : ["rm", "--cached", "-r", "--ignore-unmatch", "--", "."];
      await repository.cli.call(root, args, {
        write: true,
        timeoutMs: longWriteTimeoutMs,
        captureBytes: 65_536,
        env: literalEnv,
      });
      return;
    }
    const args = paths ? ["reset", "HEAD", "--", ...paths] : ["reset", "HEAD", "--"];
    await repository.cli.call(root, args, {
      write: true,
      timeoutMs: longWriteTimeoutMs,
      captureBytes: 65_536,
      env: literalEnv,
    });
  });
}

async function transportEnv(repository: Repository, root: string): Promise<Record<string, string>> {
  const configured = await repository.cli.call(root, ["config", "--get", "core.sshCommand"], {
    allowFailure: true,
  });
  return {
    GCM_INTERACTIVE: "never",
    ...(configured.exitCode === 1 ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
  };
}

function classifyFetchError(stderr: string): GitError {
  const diagnostics = new GitDiagnostics();
  diagnostics.accept(Buffer.from(stderr));
  if (diagnostics.finish() === "auth_failed")
    return new GitError("auth_failed", "The remote refused the credentials", { stderr });
  if (/couldn't find remote ref/i.test(stderr))
    return new GitError("remote_ref_not_found", "The remote has no such branch", { stderr });
  if (/cannot lock ref|unable to update local ref/i.test(stderr))
    return new GitError("git_failed", "Could not update remote-tracking refs", { stderr });
  return new GitError("remote_unreachable", "Could not reach the remote", { stderr });
}

async function resolveRemote(
  repository: Repository,
  root: string,
  branch: string | null,
  requested?: string,
): Promise<string> {
  const remotes = await remoteNames(repository, root);
  if (requested !== undefined) {
    const name = remoteName.parse(requested);
    if (!remotes.includes(name)) throw new GitError("invalid_argument", `No remote named ${name}`);
    return name;
  }
  if (branch) {
    const configured = await repository.cli.call(
      root,
      ["config", "--get", `branch.${branch}.remote`],
      { allowFailure: true },
    );
    const branchRemote = configured.exitCode === 0 ? configured.stdout.toString("utf8").trim() : "";
    if (branchRemote && remotes.includes(branchRemote)) return branchRemote;
  }
  if (remotes.includes("origin")) return "origin";
  const first = remotes[0];
  if (first) return first;
  throw new GitError("no_upstream", failureMessage("no_upstream"));
}

/** Fetch updates from a remote (default: branch's upstream remote or origin) with pruning. */
export async function fetchRemote(
  repository: Repository,
  options: { worktree: string; remote?: string | undefined; timeoutMs?: number | undefined },
): Promise<void> {
  const root = await repository.root(options.worktree);
  const info = await repository.info(root);
  const remote = await resolveRemote(repository, root, info.branch, options.remote);
  const env = await transportEnv(repository, root);
  const result = await repository.cli.fetch(
    root,
    [
      "fetch",
      "--prune",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--end-of-options",
      remote,
    ],
    {
      write: true,
      allowFailure: true,
      captureBytes: 65_536,
      timeoutMs: options.timeoutMs ?? 60_000,
      env,
    },
  );
  if (result.exitCode !== 0) throw classifyFetchError(result.stderr);
}
