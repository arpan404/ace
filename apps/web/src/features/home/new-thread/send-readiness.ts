/** What New thread knows when the person presses Send. */
export interface ReadinessFacts {
  /** A saved worktree base the repository no longer has. */
  missingBase: boolean;
  /** A saved model, account, effort or speed the catalog no longer lists. */
  missingSelection: boolean;
  /** Saved files whose draft scope the daemon lost. */
  missingFiles: boolean;
  /** The model catalog has answered (or failed). */
  catalogLoaded: boolean;
  /** A model to start on: the catalog's choice, or the last start's while the catalog loads. */
  hasModel: boolean;
  /** Worktree or local checkout is decided. */
  modeKnown: boolean;
  accessFailed: boolean;
  /** The provider has no mode as strict as the one asked for. */
  noStricterAccess: string | undefined;
  /** The draft carries files, which only travel through a draft scope. */
  hasFiles: boolean;
  scopeReady: boolean;
  /** A worktree's base waits on the branches being read. */
  branchesPending: boolean;
  /** The issue or pull request it starts from couldn't be read. */
  sourceProblem: string | undefined;
}

export interface Readiness {
  /** Something the person has to fix: shown above the composer in the strip's place. */
  problem: string | undefined;
  /** Something about to arrive: Send waits quietly, the reason read only by assistive tech. */
  pending: string | undefined;
}

/**
 * Whether a message can start its thread now. A text-only message needs only a model and where
 * it runs; files also wait for their draft scope, and a worktree for its base branch. Anything
 * else (access modes, the catalog when the last start's model stands in) settles on the daemon.
 */
export function sendReadiness(facts: ReadinessFacts): Readiness {
  const problem = facts.missingBase
    ? "The saved base branch is unavailable. Choose an available branch before sending."
    : facts.missingSelection
      ? "A saved model, account, or reasoning setting is unavailable. Choose an available setting before sending."
      : facts.missingFiles
        ? "Saved attachments are unavailable. Remove and add them again before sending."
        : facts.accessFailed
          ? "Couldn't check provider access. Reconnect and try again."
          : facts.catalogLoaded && !facts.hasModel
            ? "No model selected. Open the model menu to refresh or sign in."
            : (facts.noStricterAccess ?? facts.sourceProblem);
  const pending = !facts.hasModel
    ? "Loading models"
    : !facts.modeKnown
      ? "Reading where the thread runs"
      : facts.hasFiles && !facts.scopeReady
        ? "Preparing the attached files"
        : facts.branchesPending
          ? "Reading the project's branches"
          : undefined;
  return { problem, pending: problem ? undefined : pending };
}
