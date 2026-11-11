import { GitLabApi, GitLabLifecycle, gitLabLifecycleWrites, type CommandRunner } from "@ace/forge";
import type { ForgeRepository } from "@ace/protocol";
import type { ForgeBackends } from "./forge-backends.ts";

/** The lifecycle journal only needs this structural contract from either host. */
export interface HostedLifecycleBackend {
  lifecycle: Pick<GitLabLifecycle, "snapshot" | "apply" | "observe">;
}
export async function gitLabLifecycleBackend(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<HostedLifecycleBackend> {
  const runner: CommandRunner = await backends.hostRunner(
    cwd,
    repository,
    gitLabLifecycleWrites(repository),
    signal,
  );
  return { lifecycle: new GitLabLifecycle(new GitLabApi({ repository, runner })) };
}
