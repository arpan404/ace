import { repositoryKey, resolveProjectRepositories } from "@ace/forge";
import type { GitService } from "@ace/git";
import type { CheckoutRemote } from "@ace/forge";
import type { CommandPayload, ForgePrWorkspace, ForgeRepository } from "@ace/protocol";
import { resolvePrHead, type PrHead } from "./pr-head.ts";
import type { SourceControl } from "./source-control.ts";
import { workspaceRepository } from "./workspace-repository.ts";

type Preferences = Parameters<typeof workspaceRepository>[1];

/** A targeted push's destination: the PR head, the project's primary, and whether it chose. */
export interface PrPushTarget {
  head: PrHead;
  primary: ForgeRepository | undefined;
  /** The project has saved repository choices; without them only the global remote is pushed. */
  chosen: boolean;
}

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
  /**
   * Where a targeted push (the push before opening a PR) goes (ADR 0120): the PR head the
   * project's repositories pick. Absent, the checkout's remotes are read with no saved choices.
   */
  prHead?: () => Promise<PrPushTarget>,
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
    // A plain push goes where the person's Git would push: the remote the client names.
    await git.push({ worktree: cwd, remote: input.remote, beforePush: allowed, ...force });
    return;
  }
  const globalRemote = preferences?.remote ?? "origin";
  const info = await git.repositoryInfo(cwd);
  allowed();
  const target = input.target;
  const aliases =
    (await sourceControl?.hostAliases(
      info.remotes.flatMap((entry) => [...entry.fetchUrls, ...entry.pushUrls]),
      new AbortController().signal,
    )) ?? {};
  allowed();
  const pr = prHead
    ? await prHead()
    : await prHeadWithoutChoices(info.remotes, preferences, aliases);
  allowed();
  // The client names the project's primary as it saw it, and either the global remote name
  // (every client's push remote) or the head's own remote; the daemon picks the head.
  if (
    !pr.primary ||
    repositoryKey(pr.primary) !== repositoryKey(target.repository) ||
    !pr.head.remote ||
    (input.remote !== globalRemote && input.remote !== pr.head.remote) ||
    (!pr.chosen && pr.head.remote !== globalRemote)
  )
    throw new Error("repository_mismatch");
  const remote = info.remotes.find((entry) => entry.name === pr.head.remote);
  if (!remotePushesTo(remote, pr.head.pushed.repository, preferences, aliases))
    throw new Error("repository_mismatch");
  await git.push({
    worktree: cwd,
    remote: remote.name,
    beforePush: allowed,
    ...force,
    expected: { branch: target.branch, head: target.head, pushUrls: remote.pushUrls },
  });
}

/** Where a targeted push goes for a checkout with no saved choices: the primary, read locally. */
async function prHeadWithoutChoices(
  remotes: readonly CheckoutRemote[],
  preferences: Preferences,
  aliases: Readonly<Record<string, string>>,
): Promise<PrPushTarget> {
  const resolved = resolveProjectRepositories({ remotes, preferences, aliases, config: undefined });
  const head = await resolvePrHead({
    resolved,
    globalRemote: preferences?.remote ?? "origin",
    // Without choices the global remote name's repository is the primary: nothing is read.
    metadata: () => Promise.reject(new Error("repository_mismatch")),
  });
  return { head, primary: resolved.primary?.repository, chosen: false };
}
