import { ProjectCloneUrl } from "@ace/protocol";
import { GitCli, textOutput } from "./cli.ts";
import { GitError } from "./types.ts";
import { parseRemotes, parseWorktrees } from "./parse.ts";
import { within } from "./repository.ts";

export function validateCloneUrl(value: string): void {
  if (!ProjectCloneUrl.safeParse(value).success)
    throw new GitError("invalid_argument", "Use HTTPS, SSH or git@ without embedded credentials");
}

export interface CloneOptions {
  directoryFd?: number;
  parent: string;
  path: string;
  url: string;
  signal: AbortSignal;
  progress(value: { phase: "receiving" | "resolving" | "checkout"; percent: number }): void;
}
/** Test fixtures alone may replace the URL validator and permitted transport list. */
export interface ProjectGitPolicy {
  validateUrl?(url: string): void;
  protocols?: readonly string[];
}
export async function cloneRepository(
  cli: GitCli,
  input: CloneOptions,
  policy: ProjectGitPolicy,
): Promise<void> {
  (policy.validateUrl ?? validateCloneUrl)(input.url);
  const protocols = policy.protocols ?? ["https", "ssh"];
  let pending = "";
  let previous = "";
  await cli.call(
    input.parent,
    [
      "-c",
      "protocol.allow=never",
      ...protocols.flatMap((protocol) => ["-c", `protocol.${protocol}.allow=always`]),
      "clone",
      "--progress",
      "--",
      input.url,
      input.directoryFd === undefined ? input.path : ".",
    ],
    {
      write: true,
      directoryFd: input.directoryFd,
      signal: input.signal,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: protocols.join(":") },
      captureBytes: 4096,
      stderr: (chunk) => {
        // Report only numeric progress, never URLs, helper output or credential diagnostics.
        pending += chunk.toString("utf8");
        const lines = pending.split(/[\r\n]/);
        pending = (lines.pop() ?? "").slice(-4096);
        for (const line of lines) {
          const match = /^(Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/.exec(
            line,
          );
          if (!match) continue;
          const percent = Number(match[2]);
          if (percent > 100 || line === previous) continue;
          previous = line;
          const phase =
            match[1] === "Receiving objects"
              ? "receiving"
              : match[1] === "Resolving deltas"
                ? "resolving"
                : "checkout";
          input.progress({ phase, percent });
        }
      },
    },
  );
}
export async function initialBranch(
  cli: GitCli,
  cwd: string,
  directoryFd?: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await cli.call(cwd, ["config", "--get", "init.defaultBranch"], {
    allowFailure: true,
    directoryFd,
    signal,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new GitError("git_failed", "Cannot read default branch");
  return result.exitCode === 0 ? textOutput(result) : "main";
}
export async function defaultBranch(
  cli: GitCli,
  cwd: string,
  directoryFd?: number,
  signal?: AbortSignal,
): Promise<string> {
  const remote = await cli.call(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowFailure: true, directoryFd, signal },
  );
  if (remote.exitCode === 0) return textOutput(remote).replace(/^origin\//, "");
  for (const branch of ["main", "master"]) {
    const local = await cli.call(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      allowFailure: true,
      directoryFd,
      signal,
    });
    if (local.exitCode === 0) return branch;
  }
  return initialBranch(cli, cwd, directoryFd, signal);
}
export async function initRepository(
  cli: GitCli,
  cwd: string,
  branch?: string,
  directoryFd?: number,
): Promise<void> {
  const selected = branch ?? (await initialBranch(cli, cwd, directoryFd));
  const checked = await cli.call(cwd, ["check-ref-format", "--branch", selected], {
    allowFailure: true,
    directoryFd,
  });
  if (checked.exitCode !== 0 || selected.startsWith("-"))
    throw new GitError("invalid_ref", "Invalid initial branch");
  await cli.call(cwd, ["init", `--initial-branch=${selected}`, "--", "."], {
    write: true,
    directoryFd,
  });
}

/** Branch and remotes without status, index refresh, untracked traversal or ahead/behind walks. */
export async function projectInfo(
  cli: GitCli,
  path: string,
  directoryFd?: number,
  signal?: AbortSignal,
) {
  const options = { directoryFd, signal, allowFailure: true };
  const inside = await cli.call(path, ["rev-parse", "--is-inside-work-tree"], options);
  if (inside.exitCode !== 0 || textOutput(inside) !== "true")
    throw new GitError("not_a_repo", "Not a Git working tree");
  const trees = parseWorktrees(
    (await cli.call(path, ["worktree", "list", "--porcelain", "-z"], { directoryFd, signal }))
      .stdout,
  );
  const root = trees
    .filter((tree) => !tree.bare && within(tree.path, path))
    .toSorted((a, b) => b.path.length - a.path.length)[0]?.path;
  if (!root) throw new GitError("not_a_repo", "No containing Git worktree");
  const branch = await cli.call(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  if (branch.exitCode !== 0 && branch.exitCode !== 1)
    throw new GitError("git_failed", "Cannot read current branch");
  const remotes = await cli.call(
    path,
    ["config", "-z", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
    options,
  );
  if (remotes.exitCode !== 0 && remotes.exitCode !== 1)
    throw new GitError("git_failed", "Cannot read remotes");
  return {
    root,
    branch: branch.exitCode === 0 ? textOutput(branch) : null,
    remotes: parseRemotes(remotes.stdout),
  };
}
