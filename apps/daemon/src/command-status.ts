import type { CommandResult, CommandStatusState } from "@ace/protocol";

/**
 * What the daemon knows of a command a client still waits on. Work queued or executing is
 * running. A stored receipt is settled and its result is sent again; a reservation that no
 * longer has work behind it (its daemon stopped mid-effect) settles as an uncertain outcome,
 * as a replay would. With neither, the daemon has no record and the client may stop waiting.
 */
export function commandState(
  commandId: CommandResult["commandId"],
  receipt: CommandResult | undefined,
  inFlight: boolean,
): { state: CommandStatusState; result?: CommandResult } {
  if (inFlight) return { state: "running" };
  if (receipt?.error === "client_action_pending")
    return {
      state: "settled",
      result: { commandId, ok: false, error: "action_outcome_uncertain" },
    };
  if (receipt) return { state: "settled", result: receipt };
  return { state: "unknown" };
}
