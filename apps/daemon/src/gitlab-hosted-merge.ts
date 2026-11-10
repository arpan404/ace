import { GitLabHostedMerge, gitlabMergeWrites } from "@ace/forge";
import type { ForgeRepository } from "@ace/protocol";
import type { ForgeBackends } from "./forge-backends.ts";

/** Identity and project visibility are checked before constructing any merge writer.
 * Feed the resulting backend to WorkspaceForgeActions so hosted and linked writes share
 * the same durable receipt and PR fence. */
export async function gitlabHostedMerge(options: {
  backends: Pick<ForgeBackends, "hostRunner">;
  cwd: string;
  repository: ForgeRepository;
  signal: AbortSignal;
}): Promise<GitLabHostedMerge> {
  const { backends, cwd, repository, signal } = options;
  const runner = await backends.hostRunner(cwd, repository, gitlabMergeWrites, signal);
  return new GitLabHostedMerge({ repository, runner });
}
