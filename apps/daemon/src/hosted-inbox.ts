import {
  GitLabApi,
  GitLabInbox,
  gitLabInboxWrites,
  ForgeError,
  type GitHubInbox,
} from "@ace/forge";
import type { ForgeRepository } from "@ace/protocol";
import type { ForgeBackends } from "./forge-backends.ts";

export type HostedInbox = Pick<GitHubInbox, "host" | "list" | "write">;
/** Fresh per request: identity or repository choices never reuse an old inbox instance. */
export async function gitLabInboxBackend(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<GitLabInbox> {
  const runner = await backends.hostRunner(cwd, repository, [], signal);
  return new GitLabInbox(new GitLabApi({ repository, runner }));
}
/** Account-wide IDs are resolved to their actual project before checking its visibility. */
export async function gitLabInboxWriter(
  backends: ForgeBackends,
  cwd: string,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<Pick<HostedInbox, "write">> {
  const reader = await gitLabInboxBackend(backends, cwd, repository, signal);
  return {
    write: async (input, abort, dispatch) => {
      if (input.action !== "done") throw new ForgeError("unsupported", undefined, false);
      const todo = await reader.find(input.id, abort);
      const runner = await backends.hostRunner(cwd, todo.repository, gitLabInboxWrites, abort);
      await new GitLabInbox(new GitLabApi({ repository: todo.repository, runner })).write(
        input,
        abort,
        dispatch,
      );
    },
  };
}
