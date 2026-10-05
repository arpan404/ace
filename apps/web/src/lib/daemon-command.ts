import type { ClientApi } from "@ace/client";
import { useConnectionState } from "@ace/client-react";
import type { CommandPayload, CommandResult } from "@ace/protocol";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";

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

const loadFailures: Record<string, string> = {
  unavailable: "The daemon didn't answer. This loads again once it does.",
  timeout: "The daemon took too long to answer. Try again in a moment.",
  offline: "This device lost the connection to the daemon. This loads again once it's back.",
  forbidden: "This device isn't allowed to read this.",
  not_implemented: "This daemon can't show this yet. Update ace on that machine.",
};

/**
 * The daemon error code behind a failed read: the code the daemon sent (`ClientError` "daemon"
 * carries it as its message), else the client's own code (timeout, offline...).
 */
export function daemonErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "ClientError" && "code" in error) {
    const code = String(error.code);
    return code === "daemon" ? error.message : code;
  }
  return "unknown";
}

/** Why a read failed, as a sentence for an error state: never the raw code. */
export function describeDaemonError(code: string): string {
  return loadFailures[code] ?? "Something went wrong reading this from the daemon. Try again.";
}

/** What a control that needs the daemon right now says while the connection is away. */
export const needsDaemonMessage = "Reconnect to the daemon to do this";

/**
 * One rule for controls backed by a one-off request (`Client.request`, `runCommand`), which is
 * never queued while offline (OF-5). While the daemon is away such a control stays focusable
 * but `aria-disabled`, its tooltip says `reason`, and activating it says the same in a toast
 * instead of firing a request that can only fail. Durable intents queue and stay enabled.
 */
export function useDaemonReady() {
  const ready = useConnectionState() === "ready";
  const toast = useToast();
  return useMemo(
    () => ({
      ready,
      /** For the control's tooltip; undefined while connected. */
      reason: ready ? undefined : needsDaemonMessage,
      /** Spread on the control. */
      props: ready ? {} : { "aria-disabled": true as const },
      /** Wrap the control's action: it runs only while connected. */
      guard<A extends unknown[]>(action: (...args: A) => void) {
        return (...args: A) => {
          if (ready) action(...args);
          else toast.add({ title: needsDaemonMessage });
        };
      },
    }),
    [ready, toast],
  );
}
