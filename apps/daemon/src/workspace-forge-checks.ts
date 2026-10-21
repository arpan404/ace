import { ForgeIntents, WriteDispatch, repositoryKey, type GitHubForge } from "@ace/forge";
import { ForgeHostedChecksCommand } from "@ace/protocol";

/**
 * Re-runs of a PR's GitHub Actions workflow runs. The run's attempt number is GitHub's own
 * durable receipt: a write whose result was lost is settled by reading the run, and a retry of
 * one that landed finds the run past its attempt and writes nothing.
 */
export class WorkspaceForgeChecks {
  readonly #intents = new ForgeIntents();
  execute(
    input: unknown,
    backend: GitHubForge,
    signal: AbortSignal,
    allowed: () => boolean,
  ): Promise<void> {
    const { pr, action } = ForgeHostedChecksCommand.parse(input);
    // One write per workflow run at a time: a second waits and then sees the first's attempt.
    const key = `${repositoryKey(pr.repository)}#run:${action.runId}`;
    return this.#intents.run(key, async () => {
      const dispatch = new WriteDispatch();
      try {
        await backend.checks.rerun(action, signal, allowed, dispatch);
      } catch (error) {
        if (dispatch.definitelyFailed) throw error;
        if (!signal.aborted) {
          try {
            if (await backend.checks.rerunLanded(action.runId, action.attempt, signal)) return;
          } catch {
            /* Unconfirmed: report the uncertainty, never a failure that invites a blind retry. */
          }
        }
        throw new Error("action_outcome_uncertain", { cause: error });
      }
    });
  }
}
