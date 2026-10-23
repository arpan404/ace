import { RunId, type CommandId } from "@ace/protocol";

/**
 * What became of an input the engine accepted (a `thread.send` or `thread.create`):
 * - `waiting`: still in the queue;
 * - `sending`: taken from the queue, on its way to the provider;
 * - `delivered`: in the transcript, with the run that took it once one has (`runId`);
 * - `uncertain`: it may or may not have reached the provider; the person decides;
 * - `replaced`: the person sent it again, as command `by`;
 * - `removed`: the person took it out of the queue;
 * - `failed`: it will not be sent (`error` says why);
 * - `unknown`: the engine has no record of it.
 */
export type InputFate =
  | { state: "waiting" }
  | { state: "sending" }
  | { state: "delivered"; runId?: RunId }
  | { state: "uncertain" }
  | { state: "replaced"; by: CommandId }
  | { state: "removed" }
  | { state: "failed"; error: string }
  | { state: "unknown" };

export interface InputFacts {
  replacement: CommandId | undefined;
  /** Whether the input's transcript item was written. */
  written: boolean;
  runId: string | undefined;
  intent:
    | {
        status: "pending" | "queued" | "running" | "done" | "failed";
        uncertain: boolean;
        error: string | undefined;
      }
    | undefined;
}

/** The queue's own words for a message the person took out. */
const removedFromQueue = "Removed from queue";

export function inputFate(facts: InputFacts): InputFate {
  if (facts.replacement) return { state: "replaced", by: facts.replacement };
  // A steer joins its run when admitted, before the provider takes it: a lost one stays uncertain.
  if (facts.intent?.uncertain) return { state: "uncertain" };
  if (facts.runId !== undefined) return { state: "delivered", runId: RunId.parse(facts.runId) };
  if (facts.written) return { state: "delivered" };
  switch (facts.intent?.status) {
    case undefined:
      return { state: "unknown" };
    case "pending":
    case "queued":
      return { state: "waiting" };
    case "running":
      return { state: "sending" };
    case "done":
      return { state: "delivered" };
    case "failed":
      return facts.intent.error === removedFromQueue
        ? { state: "removed" }
        : { state: "failed", error: facts.intent.error ?? "Not sent" };
  }
}
