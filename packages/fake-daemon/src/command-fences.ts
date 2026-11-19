import type { Command } from "@ace/protocol";
import type { ThreadHost } from "./thread-host.ts";

/*
 * The fences the daemon puts on commands decided on a copy that may be old, applied the same
 * way here: each looks at the thread as it is when the command arrives and says whether the
 * command still means what its sender saw. Pure over the thread host.
 */

type Payload = Command["payload"];

/**
 * An archive or delete decided at event `beforeSeq` is refused (`thread_changed`) once newer
 * work started in the thread after it.
 */
export function listActionChanged(host: ThreadHost, payload: Payload): boolean {
  return (
    (payload.type === "thread.delete" || payload.type === "thread.archive") &&
    payload.beforeSeq !== undefined &&
    host.workSeq > payload.beforeSeq
  );
}

/**
 * A Stop naming a run that is no longer its agent's active one (`stale_interrupt`): it would
 * stop a run started after it was pressed.
 */
export function staleInterrupt(
  host: ThreadHost | undefined,
  payload: Extract<Payload, { type: "thread.interrupt" }>,
): boolean {
  if (!host || payload.runId === undefined) return false;
  const run = host.view.runs[payload.runId];
  const target = payload.agentId ?? host.view.thread.rootAgentId;
  return run?.state !== "active" || run.agentId !== target;
}

/** A steer whose sender saw another root run (or none, `null`) than the active one queues. */
export function fencedDelivery(
  host: ThreadHost,
  delivery: "steer" | "queue",
  seen: string | null | undefined,
): "steer" | "queue" {
  if (delivery !== "steer" || seen === undefined) return delivery;
  const root = host.view.thread.rootAgentId;
  const active =
    Object.values(host.view.runs).find((run) => run.agentId === root && run.state === "active")
      ?.id ?? null;
  return active === seen ? "steer" : "queue";
}
