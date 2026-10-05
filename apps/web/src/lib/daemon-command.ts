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
  thread_transition_in_progress: "The thread is switching providers; try again in a moment.",
  workspace_change_in_progress: "The thread is moving to another checkout; try again in a moment.",
  queue_capacity_exceeded: "The queue is full. Send or remove a queued message first.",
  queue_limit: "The queue is full. Send or remove a queued message first.",
  stale_interrupt: "That turn had already ended.",
  fork_point_unavailable: "That turn can't be forked.",
  provider_unavailable: "That provider isn't installed or signed in.",
  not_implemented: "This daemon can't do that yet.",
  forbidden: "This device isn't allowed to do that.",
};

export function refusalMessage(code: string): string {
  return refusals[code] ?? `The daemon refused (${code}).`;
}

/*
 * Two rules for what a person asks of the daemon (UX audit SY-4):
 *
 * - Durable (sends, create, Stop, answers, organize, queue edits, approval mode, model): saved
 *   in the client's outbox before anything is sent, resent on reconnect, idempotent on the
 *   daemon by command id. Offline or slow is never a failure: the UI applies the change at once
 *   and says "Will apply when reconnected", or "Still waiting for the daemon…" after five
 *   seconds, until the receipt. Only a definite refusal rolls anything back.
 * - One-shot (reads, previews): `client.request`, never saved and never resent.
 */

/**
 * Send a durable command and wait for the daemon's receipt (`Client.command`). It is saved
 * before it is sent, survives a reload and goes out when the connection returns, so the wait
 * has no deadline. Rejects with `CommandRefused` when the daemon says no, or with a
 * `ClientError` only when this device couldn't save it at all. Pass `id` to retry the same
 * command: the daemon applies a command id once.
 */
export async function runCommand(
  client: ClientApi,
  payload: CommandPayload,
  id?: string,
): Promise<CommandResult> {
  const result = await client.command(payload, {}, id);
  if (!result.ok) throw new CommandRefused(result.error ?? "command_failed");
  return result;
}

/** What went wrong, in a sentence for a toast. */
export function failureMessage(error: unknown): string {
  if (error instanceof CommandRefused) return error.message;
  if (error instanceof Error && error.name === "ClientError")
    return "This device couldn't save it. Try again.";
  return "Something went wrong. Try again.";
}

/** The daemon's limit on one message: its command, as JSON. */
export const messageLimitBytes = 256 * 1024;

const kilobytes = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/**
 * Why a message wasn't sent, in words for its bubble's "Not sent" line, e.g. "Too long: 312 KB,
 * the limit is 256 KB" (`payload` lets the size be said). `code` is the daemon's refusal or the
 * client's own failure (`limit`, `storage`).
 */
export function sendFailure(code: string | undefined, payload?: CommandPayload): string {
  if (code === "message_too_large" && payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    return `Too long: ${kilobytes(bytes)}, the limit is ${kilobytes(messageLimitBytes)}`;
  }
  if (code === "limit") return "This device has too much waiting to send. Try again in a moment.";
  if (code === "storage") return "This browser couldn't save the message.";
  return code ? refusalMessage(code) : "The daemon didn't take it.";
}

/**
 * The note under something durable while it waits: offline it applies when the connection
 * returns; online, five seconds without a receipt means the daemon is slow. Undefined while
 * nothing needs saying.
 */
export function waitingNote(waiting: { online: boolean; slow: boolean }): string | undefined {
  if (!waiting.online) return "Will apply when reconnected";
  if (waiting.slow) return "Still waiting for the daemon…";
  return undefined;
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
