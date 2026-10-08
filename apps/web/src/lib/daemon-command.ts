import type { ClientApi } from "@ace/client";
import { useConnectionState } from "@ace/client-react";
import type { CommandPayload, CommandResult } from "@ace/protocol";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";

/** A command the daemon refused, with its error code and a sentence a person can act on. */
export class CommandRefused extends Error {
  readonly code: string;
  readonly alive: CommandResult["alive"];
  constructor(code: string, alive?: CommandResult["alive"]) {
    super(alive && stillAlive(alive) ? aliveMessage(alive) : refusalMessage(code));
    this.name = "CommandRefused";
    this.code = code;
    this.alive = alive;
  }
}

const refusals: Record<string, string> = {
  thread_not_found: "The thread is gone.",
  thread_not_done: "Only a finished thread can settle.",
  thread_busy: "Stop its agents and close its terminals first.",
  thread_deleting: "It's already being stopped and deleted.",
  thread_cleanup_pending: "Its agents haven't stopped yet. ace will finish deleting it.",
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
  workspace_preparing: "Its checkout is still being prepared; try again in a moment.",
  thread_move_requires_local_workspace:
    "It works in its own worktree. Switch it to the local checkout first.",
  workspace_not_found: "That project is gone.",
  worktree_base_not_found: "That branch doesn't exist any more. Pick another to start from.",
  worktree_base_unreachable:
    "The remote couldn't be reached and that branch was never fetched. Check the connection, or start from a local branch.",
  workspace_changed: "That project just changed; try again.",
  thread_move_failed: "ace couldn't move it. Try again.",
  queue_capacity_exceeded: "The queue is full. Send or remove a queued message first.",
  queue_limit: "The queue is full. Send or remove a queued message first.",
  stale_interrupt: "That turn had already ended.",
  fork_tree_is_live: "Wait for all agents in the fork to finish, then try again.",
  source_tree_is_live: "Wait for all agents in the parent to finish before including code changes.",
  source_thread_not_found: "The parent thread is gone. Keep the summary in this thread.",
  thread_is_not_a_fork: "This thread has no parent to bring results back to.",
  invalid_citation_thread: "The answer could not be linked. Reopen the fork and try again.",
  merge_queue_capacity_exceeded:
    "The parent has several results waiting. Try again after its next turn.",
  merge_patch_too_large:
    "The code changes are too large to bring back here. Bring back the summary and apply the changes in git.",
  merge_patch_unavailable:
    "Couldn't read code changes. Check that this thread has a git checkout, then try again.",
  merge_patch_empty:
    "There are no uncommitted code changes to include. Turn off Include code changes and try again.",
  pi_rewind_failed:
    "Couldn't rewind this conversation. Wait for all agents to finish. If the session has closed, send a message to resume it, then try again.",
  fork_point_unavailable: "That turn can't be forked.",
  provider_unavailable: "That provider isn't installed or signed in.",
  not_implemented: "ace on this machine can't do that yet.",
  forbidden: "This device isn't allowed to do that.",
};

/** Whether a refusal found work still running, so Stop and delete has something to stop. */
export function stillAlive(alive: CommandResult["alive"]): boolean {
  return alive !== undefined && Object.values(alive).some((count) => count > 0);
}

function counted(n: number, one: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${one}s`;
}

/** "Still running: 1 agent, 2 terminals." */
function aliveMessage(alive: NonNullable<CommandResult["alive"]>): string {
  const parts = [
    alive.agentsRunning ? counted(alive.agentsRunning, "agent") : "",
    alive.terminalsOpen ? counted(alive.terminalsOpen, "terminal") : "",
    alive.operationsRunning ? counted(alive.operationsRunning, "operation") : "",
  ].filter(Boolean);
  return `Still running: ${parts.join(", ")}.`;
}

export function refusalMessage(code: string): string {
  return refusals[code] ?? "ace couldn't complete that action. Try again.";
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
  if (!result.ok) throw new CommandRefused(result.error ?? "command_failed", result.alive);
  return result;
}

/** What went wrong, in a sentence for a toast. */
export function failureMessage(error: unknown): string {
  if (error instanceof CommandRefused) return error.message;
  if (error instanceof Error && error.name === "ClientError")
    return "This device couldn't save it. Try again.";
  return "Something went wrong. Try again.";
}

/**
 * The note under something durable while it waits: offline it applies when the connection
 * returns; online, five seconds without a receipt means the daemon is slow. Undefined while
 * nothing needs saying.
 */
export function waitingNote(waiting: { online: boolean; slow: boolean }): string | undefined {
  if (!waiting.online) return "Will apply when reconnected";
  if (waiting.slow) return "Still waiting for ace…";
  return undefined;
}

const loadFailures: Record<string, string> = {
  unavailable: "ace didn't answer. This loads again once it does.",
  timeout: "ace took too long to answer. Try again in a moment.",
  offline: "This device lost the connection to ace. This loads again once it's back.",
  forbidden: "This device isn't allowed to read this.",
  not_implemented: "ace on this machine can't show this yet. Update ace on that machine.",
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
  return loadFailures[code] ?? "Something went wrong reading this from ace. Try again.";
}

/** What a control that needs the daemon right now says while the connection is away. */
export const needsDaemonMessage = "Reconnect to ace to do this";

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
