import type { BaseRefs } from "@/lib/branches.ts";
import { useDaemonSetting, useExplicitDaemonSetting } from "@/lib/daemon-setting.ts";
import type { WorkMode } from "./choices.ts";

/**
 * Where a new thread runs when this device hasn't chosen: Settings' "Use worktree" once the
 * daemon has answered, a worktree when it couldn't be read, and undefined while it loads, so a
 * choice made meanwhile never saves a guess.
 */
export function useDefaultWorkMode(): WorkMode | undefined {
  const [useWorktree] = useDaemonSetting("threads.useWorktree");
  const { loaded } = useExplicitDaemonSetting("threads.useWorktree");
  if (useWorktree !== undefined) return useWorktree ? "worktree" : "local";
  return loaded ? "worktree" : undefined;
}

const noWorktreeReasons: Record<NonNullable<BaseRefs["noWorktree"]>, string> = {
  not_a_repo: "Not a Git repository",
  no_commits: "No commits yet",
};

/** Why the project can't start a worktree, for the Worktree checkbox's disabled reason. */
export function noWorktreeReason(branches: BaseRefs): string | undefined {
  return branches.noWorktree && noWorktreeReasons[branches.noWorktree];
}
