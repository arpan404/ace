import { repositoryKey } from "@ace/forge";
import type { GitService } from "@ace/git";
import type { CommandPayload, ForgeRepository } from "@ace/protocol";
import type { SourceControl } from "./source-control.ts";
import { workspaceRepository } from "./workspace-repository.ts";

type Preferences = Parameters<typeof workspaceRepository>[1];

/** Every push URL of `remote` must name the selected hosted repository. */
export function remotePushesTo<Remote extends { pushUrls: readonly string[] }>(
  remote: Remote | undefined,
  repository: ForgeRepository,
  preferences: Preferences,
): remote is Remote {
  return (
    !!remote &&
    remote.pushUrls.length > 0 &&
    remote.pushUrls.every((url) => {
      // Map the URL alone; which remote is selected was decided by the caller.
      const name = preferences?.remote ?? "origin";
      const pushed = workspaceRepository([{ name, fetchUrls: [url] }], preferences);
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
) {
  const check = await sourceControl?.guard();
  const preferences = await sourceControl?.preferences();
  const allowed = () => {
    check?.();
    if (!permitted()) throw new Error("forbidden");
  };
  allowed();
  if (!input.target) {
    await git.push({ worktree: cwd, remote: input.remote, beforePush: allowed });
    allowed();
    return;
  }
  if (input.remote !== (preferences?.remote ?? "origin")) throw new Error("repository_mismatch");
  const info = await git.repositoryInfo(cwd);
  allowed();
  const remote = info.remotes.find((entry) => entry.name === input.remote);
  const target = input.target;
  const repository = workspaceRepository(info.remotes, preferences);
  if (!repository || repositoryKey(repository) !== repositoryKey(target.repository))
    throw new Error("repository_mismatch");
  if (!remotePushesTo(remote, target.repository, preferences))
    throw new Error("repository_mismatch");
  await git.push({
    worktree: cwd,
    remote: input.remote,
    beforePush: allowed,
    expected: { branch: target.branch, head: target.head, pushUrls: remote.pushUrls },
  });
  allowed();
}
