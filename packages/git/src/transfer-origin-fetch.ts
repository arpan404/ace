import { validateCloneUrl, type ProjectGitPolicy } from "./projects.ts";
import type { Repository } from "./repository.ts";
import { transferOrigin } from "./transfer-refs.ts";
import { GitError } from "./types.ts";

/** Whether the repository has `commit` as a commit object; never fetches. */
export async function hasCommit(
  repository: Repository,
  root: string,
  commit: string,
  directoryFd?: number,
): Promise<boolean> {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) return false;
  const result = await repository.cli.call(root, ["cat-file", "-e", `${commit}^{commit}`], {
    allowFailure: true,
    directoryFd,
  });
  return result.exitCode === 0;
}

/**
 * Brings every branch of `origin` into its remote-tracking refs (`refs/remotes/origin/*`), so a
 * bundle built on what the sender's origin has can be read in a clone that fell behind. Never
 * touches local branches, the checkout or tags, and never asks for credentials. Origin's URL
 * and transport pass the same project policy a clone of it would.
 */
export async function fetchOrigin(
  repository: Repository,
  root: string,
  options: { timeoutMs: number; signal?: AbortSignal | undefined },
  policy: ProjectGitPolicy = {},
): Promise<void> {
  const origin = await transferOrigin(repository, root);
  if (!origin) throw new GitError("invalid_argument", "The repository has no origin");
  (policy.validateUrl ?? validateCloneUrl)(origin.url);
  const protocols = policy.protocols ?? ["https", "ssh"];
  // Only replace ssh's command when the person hasn't configured their own.
  const configured = await repository.cli.call(root, ["config", "--get", "core.sshCommand"], {
    allowFailure: true,
  });
  const env: Record<string, string> = {
    GCM_INTERACTIVE: "never",
    GIT_TERMINAL_PROMPT: "0",
    ...(configured.exitCode === 1 ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } : {}),
  };
  const result = await repository.cli.fetch(
    root,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--end-of-options",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ],
    {
      write: true,
      allowFailure: true,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      env,
    },
    protocols,
  );
  if (result.exitCode !== 0)
    throw new GitError("remote_unreachable", "Could not fetch from origin", {
      stderr: result.stderr,
    });
}
