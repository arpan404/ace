import type { Command, CommandResult } from "@ace/protocol";
import type { WorkspaceGit } from "./workspace-roots.ts";

export type SourceControlCommandPayload = Extract<
  Command["payload"],
  { type: "git.stage" | "git.unstage" | "git.fetch" }
>;

const sourceControlTypes = new Set<string>(["git.stage", "git.unstage", "git.fetch"]);

export function isSourceControlCommand(
  payload: Command["payload"],
): payload is SourceControlCommandPayload {
  return sourceControlTypes.has(payload.type);
}

export interface SourceControlCommandContext {
  git: WorkspaceGit;
  cwd: string;
  refreshDetails: () => Promise<void>;
}

/**
 * One thread-scoped source control command. None of them rewrites the checkout's files: staging
 * changes only the index, a fetch only remote-tracking refs. Details refresh afterwards, after a
 * failure too (a failed fetch may still have moved some refs).
 */
export async function runSourceControlCommand(
  context: SourceControlCommandContext,
  payload: SourceControlCommandPayload,
): Promise<Omit<CommandResult, "commandId">> {
  const { git, cwd } = context;
  const refresh = () => context.refreshDetails().catch(() => {});
  try {
    if (payload.type === "git.stage") await git.stage({ worktree: cwd, paths: payload.paths });
    else if (payload.type === "git.unstage")
      await git.unstage({ worktree: cwd, paths: payload.paths });
    else await git.fetch({ worktree: cwd, remote: payload.remote });
  } catch (error) {
    await refresh();
    throw error;
  }
  await refresh();
  return { ok: true };
}
