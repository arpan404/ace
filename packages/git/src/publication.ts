import { scanPublication } from "./publication-scan.ts";
import type { Repository } from "./repository.ts";
import { projectInfo, validateCloneUrl, type ProjectGitPolicy } from "./projects.ts";
import { GitError } from "./types.ts";
import { hash } from "./decode.ts";

export type PublicationGitInput = {
  worktree: string;
  directoryFd: number;
  signal: AbortSignal;
  guard?: () => void;
};
export async function publicationInfo(repository: Repository, input: PublicationGitInput) {
  const info = await projectInfo(repository.cli, input.worktree, input.directoryFd, input.signal);
  const head = await repository.cli.call(input.worktree, ["rev-parse", "--verify", "HEAD"], {
    directoryFd: input.directoryFd,
    signal: input.signal,
    allowFailure: true,
  });
  if (head.exitCode !== 0 && head.exitCode !== 128)
    throw new GitError("git_failed", "Cannot read publication revision");
  return { ...info, head: head.exitCode === 0 ? hash(head.stdout.toString("utf8").trim()) : null };
}
export function publicationOriginMatches(
  remotes: Awaited<ReturnType<typeof publicationInfo>>["remotes"],
  url: string,
): boolean {
  const origin = remotes.find((entry) => entry.name === "origin");
  return (
    origin !== undefined &&
    origin.fetchUrls.length === 1 &&
    origin.fetchUrls[0] === url &&
    (origin.pushUrls.length === 0 || (origin.pushUrls.length === 1 && origin.pushUrls[0] === url))
  );
}
export async function attachPublicationOrigin(
  repository: Repository,
  input: PublicationGitInput & { url: string },
): Promise<void> {
  validateCloneUrl(input.url);
  await repository.serial(input.worktree, async () => {
    input.guard?.();
    const info = await publicationInfo(repository, input);
    input.guard?.();
    if (info.root !== input.worktree)
      throw new GitError("invalid_argument", "Publish the repository root");
    if (info.remotes.some((entry) => entry.name === "origin")) {
      if (publicationOriginMatches(info.remotes, input.url)) return;
      throw new GitError("invalid_argument", "An origin already exists");
    }
    await repository.cli.call(input.worktree, ["remote", "add", "origin", input.url], {
      directoryFd: input.directoryFd,
      signal: input.signal,
      write: true,
      beforeSpawn: input.guard,
    });
  });
}
export async function pushPublication(
  repository: Repository,
  input: PublicationGitInput & { url: string },
  policy: ProjectGitPolicy = {},
): Promise<"empty" | "pushed"> {
  validateCloneUrl(input.url);
  return repository.serial(input.worktree, async () => {
    input.guard?.();
    const info = await publicationInfo(repository, input);
    input.guard?.();
    if (!publicationOriginMatches(info.remotes, input.url))
      throw new GitError("invalid_argument", "Publication origin changed");
    if (!info.head) return "empty";
    if (!info.branch) throw new GitError("invalid_argument", "Select a branch before publishing");
    await scanPublication(repository.cli, { ...input, head: info.head });
    // Pin both destination and revision. External edits to origin/HEAD cannot redirect this push.
    await repository.cli.push(
      input.worktree,
      [
        "push",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--",
        input.url,
        `${info.head}:refs/heads/${info.branch}`,
      ],
      {
        directoryFd: input.directoryFd,
        signal: input.signal,
        write: true,
        beforeSpawn: input.guard,
        timeoutMs: 120_000,
        captureBytes: 65536,
        env: {
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        },
      },
      policy.protocols,
    );
    return "pushed";
  });
}
