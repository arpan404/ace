import { repositoryKey } from "@ace/forge";
import type { GitService } from "@ace/git";
import type { CommandPayload } from "@ace/protocol";
import type { SourceControl } from "./source-control.ts";
import { workspaceRepository } from "./workspace-repository.ts";

/** Validate the daemon's selected remote and keep the reviewed PR head pinned through push. */
export async function pushWorkspace(git: Pick<GitService, "push" | "repositoryInfo">,
  sourceControl: SourceControl | undefined, cwd: string,
  input: Extract<CommandPayload, {type: "git.push"}>, permitted: () => boolean) {
    const check = await sourceControl?.guard();
    const preferences = await sourceControl?.preferences();
    const allowed = () => { check?.(); if (!permitted()) throw new Error("forbidden"); };
    allowed();
    if (!input.target) { await git.push({ worktree: cwd, remote: input.remote, beforePush: allowed }); allowed(); return; }
    if (input.remote !== (preferences?.remote ?? "origin")) throw new Error("repository_mismatch");
    const info = await git.repositoryInfo(cwd);
    allowed();
    const remote = info.remotes.find((entry) => entry.name === input.remote);
    const target = input.target;
    const repository = workspaceRepository(info.remotes, preferences);
    if (!repository || repositoryKey(repository) !== repositoryKey(target.repository))
      throw new Error("repository_mismatch");
    if (!remote || !remote.pushUrls.length || remote.pushUrls.some((url) => {
      const repository = workspaceRepository([{ name: input.remote, fetchUrls: [url] }], preferences);
      return !repository || repositoryKey(repository) !== repositoryKey(target.repository);
    })) throw new Error("repository_mismatch");
    await git.push({ worktree: cwd, remote: input.remote, beforePush: allowed,
      expected: { branch: target.branch, head: target.head, pushUrls: remote.pushUrls } });
    allowed();
  }
