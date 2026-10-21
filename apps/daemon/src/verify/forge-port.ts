import { ForgeError } from "@ace/forge";
import { Command } from "@ace/protocol";
import type { WorkspaceRuntime } from "../workspace-runtime.ts";
import type { VerifyForge, VerifyMergeOutcome } from "./ports.ts";
import { describeError } from "./run-errors.ts";

type Runtime = Pick<WorkspaceRuntime, "forge" | "prRemote" | "execute">;

/**
 * Verify's GitHub through the daemon's workspace forge. Merges are `forge.hosted.merge`
 * commands, so each goes through the PR page's own journal, fence and uncertainty handling.
 */
export function workspaceVerifyForge(runtime: Runtime): VerifyForge {
  return {
    remote: (project, repository, signal) => runtime.prRemote(project, repository, signal),
    async base(project, pr, headSha, signal) {
      return (await runtime.forge.checkout(project, { ref: pr, headSha }, signal)).baseBranch;
    },
    async stacked(project, workspaceId, repository, numbers, signal) {
      const result = await runtime.forge.browse(
        project,
        { op: "forge.pr.stack-memberships", workspaceId, repository, numbers: [...numbers] },
        signal,
      );
      if (result.resource !== "prStackMemberships") throw new ForgeError("invalid_data");
      return result.value.flatMap((entry) => (entry.stack ? [entry.number] : []));
    },
    async merge(input): Promise<VerifyMergeOutcome> {
      const command = Command.parse({
        id: `verify-${input.runId}-${input.pr.number}`,
        deviceId: "ace-verify",
        payload: {
          type: "forge.hosted.merge",
          workspaceId: input.workspaceId,
          pr: input.pr,
          headSha: input.headSha,
          method: input.method,
        },
      });
      try {
        const result = await runtime.execute(command, input.allowed);
        if (result.ok) return { outcome: "merged" };
        if (result.error === "forge_write_uncertain" || result.error === "action_outcome_uncertain")
          return { outcome: "uncertain" };
        return { outcome: "refused", message: refusalWords(result.error) };
      } catch (error) {
        // The hosted path rethrows only a write that certainly failed.
        if (error instanceof ForgeError)
          return { outcome: "refused", message: describeError(error) };
        return { outcome: "uncertain" };
      }
    },
    async merged(project, repository, numbers, signal) {
      const states = await runtime.forge.prStates(project, repository, numbers, signal);
      return numbers.filter((number) => states.get(number)?.state === "merged");
    },
  };
}

function refusalWords(error: string | undefined): string {
  if (error === "forbidden") return "this device may no longer merge";
  if (error === "forge_write_pending") return "another merge of it is in progress";
  if (error === "action_busy") return "ace is busy with other GitHub writes";
  return error ? `GitHub refused (${error})` : "GitHub refused";
}
