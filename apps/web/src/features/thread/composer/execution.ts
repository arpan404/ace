import type { ExecutionOptions, Thread } from "@ace/protocol";

/** What a thread runs on: a switch waiting for its next turn, else its execution or live fields. */
export function runsOn(meta: Thread | undefined) {
  if (!meta) return undefined;
  if (meta.switch?.state === "queued") return meta.switch.selection;
  return (
    meta.execution ?? {
      provider: meta.provider,
      model: meta.live?.model,
      instanceId: meta.live?.account,
      options: meta.live?.options ?? {},
    }
  );
}

/**
 * Which provider, model and account a selection names. Choices made for one (a cached catalog
 * entry, effort picked for the next message) belong to it, and are checked again when it moves.
 */
export function selectionIdentity(selection: ReturnType<typeof runsOn>): string {
  if (!selection) return "";
  return JSON.stringify([selection.provider, selection.model ?? "", selection.instanceId ?? ""]);
}

/**
 * Effort and speed picked for a thread's next message, sent with it as `thread.send` options,
 * and the selection they were picked for: they never go out with another one unchecked.
 */
export interface PendingTurn {
  identity: string;
  options: ExecutionOptions;
}
