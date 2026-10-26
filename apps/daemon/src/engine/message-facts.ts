import { deriveThreadStatus, readyForChildResults, type ThreadState } from "@ace/core";
import type { Capabilities, CommandId, ThreadId } from "@ace/protocol";
import type { InputFate } from "./input-fate.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { EngineRepository, IntentHeader } from "./repository.ts";
import { rootRun } from "./steer-yield.ts";

/**
 * What the engine knows about an accepted message that decides when it reaches the model. Read
 * from the same checks the engine's own queue uses, so a caller never has to guess from status.
 */
export interface MessageFacts {
  fate: InputFate["state"];
  /** Why it will not be sent, when `fate` is `failed`. */
  error?: string;
  delivery: "queue" | "steer";
  /** A parent agent sent it. */
  fromParent: boolean;
  /** Messages waiting ahead of it in the thread's queue. */
  ahead: number;
  /** The queue is held (paused, limited) or a recovery owns the thread. */
  held: boolean;
  /** The root agent is in a turn. */
  turnRunning: boolean;
  /** Between turns, the queue would send it now (`readyForInput`). */
  acceptsInput: boolean;
  /** The provider can put input into a running turn. */
  steers: boolean;
  /** The provider's steer interrupts the running turn and restarts it with the input (Cursor). */
  restartsTurn: boolean;
}

/**
 * The capabilities of this thread's live provider: its backend's when it reports one (Cursor SDK
 * versus ACP). A thread whose own record says it can't steer never steers.
 */
export function threadCapabilities(
  repo: EngineRepository,
  registry: AdapterRegistry,
  id: ThreadId,
): Capabilities | undefined {
  const thread = repo.store.getThread(id);
  if (!thread || !registry.has(thread.provider)) return undefined;
  const recorded =
    thread.effectiveCapabilities ??
    thread.capabilities ??
    registry.get(thread.provider).capabilities;
  if (!recorded.steer || thread.effectiveCapabilities) return recorded;
  try {
    return registry.get(thread.provider, repo.backend(id)).capabilities;
  } catch {
    return recorded;
  }
}

/**
 * The queue's rule for sending a waiting input while no steer carries it. A child result waits
 * for the whole local tree. A plain message, the person's or a parent agent's, only needs the
 * provider between turns. One that changes the model or options may reopen the session, which
 * would end its background commands, so it still waits for the whole tree.
 */
export function readyForInput(
  repo: EngineRepository,
  state: ThreadState,
  intent: IntentHeader,
): boolean {
  if (intent.trigger === "subagent_result") return readyForChildResults(state);
  const status = deriveThreadStatus({ ...state, queueCount: state.queueSources.provider });
  return (
    ["new", "done", "failed"].includes(status.state) ||
    repo.quiescent(state) ||
    (intent.kind === "thread.send" &&
      (intent.trigger === undefined ||
        intent.trigger === "user" ||
        intent.trigger === "parent_agent") &&
      !repo.pending.hasSelection(intent.id) &&
      repo.acceptsPersonInput(state))
  );
}

export function readMessageFacts(
  repo: EngineRepository,
  registry: AdapterRegistry,
  id: ThreadId,
  commandId: CommandId,
  fate: InputFate,
): MessageFacts {
  const capabilities = threadCapabilities(repo, registry, id);
  const intent = repo.pending.delivery(id, commandId);
  const queue = repo.queue.get(id);
  const state = repo.state(id);
  const header = [...repo.pending.headers(id)].find((entry) => entry.commandId === commandId);
  const waiting = repo.queue.snapshot(id).messages.map((message) => message.id);
  const at = waiting.indexOf(commandId);
  return {
    fate: fate.state,
    ...(fate.state === "failed" ? { error: fate.error } : {}),
    delivery: intent?.delivery ?? "queue",
    fromParent: intent?.trigger === "parent_agent",
    ahead: at < 0 ? waiting.length : at,
    held:
      queue.paused ||
      queue.limited ||
      repo.pending.recovering(id) ||
      repo.pending.recoveryAcknowledgement(id),
    turnRunning: state !== undefined && rootRun(state) !== undefined,
    acceptsInput: !state || !header || readyForInput(repo, state, header),
    steers: capabilities?.steer ?? false,
    restartsTurn: capabilities?.steeringMode === "interrupt-restart",
  };
}
