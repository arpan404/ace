import type { ClientApi } from "@ace/client";
import type { CommandPayload, CommandResult } from "@ace/protocol";

/** A command the daemon refused, with its error code and a sentence a person can act on. */
export class CommandRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(refusalMessage(code));
    this.name = "CommandRefused";
    this.code = code;
  }
}

const refusals: Record<string, string> = {
  thread_not_found: "The thread is gone.",
  thread_not_done: "Only a finished thread can settle.",
  thread_busy: "Stop its agents and close its terminals first.",
  snooze_in_past: "That time has already passed.",
  queue_conflict: "Another device changed the queue. Here is the latest.",
  message_already_claimed: "The agent already took that message.",
  uncertain_delivery: "A message may have reached the agent. Remove it before continuing.",
  reset_time_unknown: "The provider didn't say when the limit resets.",
  migration_unavailable: "There's no other account to move to.",
  recovery_in_progress: "The thread is already resuming.",
  invalid_queue_position: "That message moved. Here is the latest order.",
  message_too_large: "The message is too large.",
  thread_transition_in_progress: "The thread is switching. Try again in a moment.",
  fork_point_unavailable: "That turn can't be forked.",
  provider_unavailable: "That provider isn't installed or signed in.",
  not_implemented: "This daemon can't do that yet.",
  forbidden: "This device isn't allowed to do that.",
};

export function refusalMessage(code: string): string {
  return refusals[code] ?? `The daemon refused (${code}).`;
}

/**
 * Send a command and wait for the daemon's receipt (`Client.command`): correlated, never queued
 * while offline, so the person learns right away whether it happened. Rejects with
 * `CommandRefused` when the daemon says no, or the client's error when it can't be reached.
 */
export async function runCommand(
  client: ClientApi,
  payload: CommandPayload,
): Promise<CommandResult> {
  const result = await client.command(payload);
  if (!result.ok) throw new CommandRefused(result.error ?? "command_failed");
  return result;
}

/** What went wrong, in a sentence for a toast. */
export function failureMessage(error: unknown): string {
  if (error instanceof CommandRefused) return error.message;
  if (error instanceof Error && error.name === "ClientError")
    return "Couldn't reach the daemon. Check the connection and try again.";
  return "Something went wrong. Try again.";
}
