import { repositoryKey } from "@ace/forge";
import type { GitService } from "@ace/git";
import type { CommandPayload, ForgePrWorkspace, ForgeRepository } from "@ace/protocol";
import type { SourceControl } from "./source-control.ts";
import { workspaceRepository } from "./workspace-repository.ts";

type Preferences = Parameters<typeof workspaceRepository>[1];

/** Every push URL of `remote` must name the selected hosted repository. */
export function remotePushesTo<Remote extends { pushUrls: readonly string[] }>(
  remote: Remote | undefined,
  repository: ForgeRepository,
  preferences: Preferences,
  aliases: Readonly<Record<string, string>> = {},
): remote is Remote {
  return (
    !!remote &&
    remote.pushUrls.length > 0 &&
    remote.pushUrls.every((url) => {
      // Map the URL alone; which remote is selected was decided by the caller.
      const name = preferences?.remote ?? "origin";
      const pushed = workspaceRepository([{ name, fetchUrls: [url] }], preferences, aliases);
      return !!pushed && repositoryKey(pushed) === repositoryKey(repository);
    })
  );
}

/** Validate the daemon's selected remote and keep the reviewed PR head pinned through push. */
export async function pushWorkspace(
  git: Pick<GitService, "push" | "repositoryInfo">,
  sourceControl: SourceControl | undefined,
  cwd: string,
  input: Extract<CommandPayload, { type: "git.push" }>,
  permitted: () => boolean,
  /** The checkout reviews this pull request: an untargeted push updates its head branch. */
  pullRequest?: Pick<ForgePrWorkspace, "headBranch" | "headRepository">,
) {
  const check = await sourceControl?.guard();
  const preferences = await sourceControl?.preferences();
  const allowed = () => {
    check?.();
    if (!permitted()) throw new Error("forbidden");
  };
  allowed();
  // Permission gates spawning only. Once git exits 0 the push happened, whatever became of the
  // socket that asked for it, and its receipt must say so for the reconnected client's replay.
  const force = input.force ? { force: input.force } : {};
  if (!input.target && pullRequest) {
    // The local `ace/…` branch is ace's own; the PR's commits belong on its head branch.
    const head = pullRequest.headRepository;
    if (!head || !pullRequest.headBranch) throw new Error("git_pr_head_unavailable");
    const info = await git.repositoryInfo(cwd);
    allowed();
    // Prefer the requested remote; any configured remote (a fork's) that pushes there will do.
    const remote = [
      info.remotes.find((entry) => entry.name === input.remote),
      ...info.remotes.filter((entry) => entry.name !== input.remote),
    ].find((entry) => remotePushesTo(entry, head, preferences));
    if (!remote) throw new Error("git_pr_head_unavailable");
    await git.push({
      worktree: cwd,
      remote: remote.name,
      destination: pullRequest.headBranch,
      beforePush: allowed,
      ...force,
      ...(info.branch
        ? { expected: { branch: info.branch, head: info.head, pushUrls: remote.pushUrls } }
        : {}),
    });
    return;
  }
  if (!input.target) {
    await git.push({ worktree: cwd, remote: input.remote, beforePush: allowed, ...force });
    return;
  }
  if (input.remote !== (preferences?.remote ?? "origin")) throw new Error("repository_mismatch");
  const info = await git.repositoryInfo(cwd);
  allowed();
  const remote = info.remotes.find((entry) => entry.name === input.remote);
  const target = input.target;
  const aliases =
    (await sourceControl?.hostAliases(
      info.remotes.flatMap((entry) => [...entry.fetchUrls, ...entry.pushUrls]),
      new AbortController().signal,
    )) ?? {};
  allowed();
  const repository = workspaceRepository(info.remotes, preferences, aliases);
  if (!repository || repositoryKey(repository) !== repositoryKey(target.repository))
    throw new Error("repository_mismatch");
  if (!remotePushesTo(remote, target.repository, preferences, aliases))
    throw new Error("repository_mismatch");
  await git.push({
    worktree: cwd,
    remote: input.remote,
    beforePush: allowed,
    ...force,
    expected: { branch: target.branch, head: target.head, pushUrls: remote.pushUrls },
  });
}
