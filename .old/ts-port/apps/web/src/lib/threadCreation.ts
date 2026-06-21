import type { DraftThreadEnvMode } from "../composerDraftStore";

export type ThreadCreationAction = "new-thread" | "new-local-thread";

interface ThreadCreationContext {
  readonly activeDraftThread: {
    readonly branch: string | null;
    readonly envMode: DraftThreadEnvMode;
    readonly worktreePath: string | null;
  } | null;
  readonly activeThread: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  } | null;
  readonly defaultNewThreadEnvMode: DraftThreadEnvMode;
}

export interface ThreadCreationOptions {
  readonly branch?: string | null;
  readonly envMode: DraftThreadEnvMode;
  readonly worktreePath?: string | null;
}

export function resolveThreadCreationOptions(
  action: ThreadCreationAction,
  context: ThreadCreationContext,
): ThreadCreationOptions {
  if (action === "new-local-thread") {
    return { envMode: context.defaultNewThreadEnvMode };
  }

  return {
    branch: context.activeThread?.branch ?? context.activeDraftThread?.branch ?? null,
    worktreePath:
      context.activeThread?.worktreePath ?? context.activeDraftThread?.worktreePath ?? null,
    envMode:
      context.activeDraftThread?.envMode ??
      (context.activeThread?.worktreePath ? "worktree" : "local"),
  };
}
