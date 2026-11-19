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
/** A Stop's words for an input it cancelled before any run took it (`stop-intents.ts`). */
export const cancelledByStop = "Cancelled before delivery";

export function inputFate(facts: InputFacts): InputFate {
  if (facts.replacement) return { state: "replaced", by: facts.replacement };
  // A steer joins its run when admitted, before the provider takes it: a lost one stays uncertain,
  // and one back in the queue (refused unread, or kept for the person) is still waiting.
  if (facts.intent?.uncertain) return { state: "uncertain" };
  if (facts.intent?.status === "pending" || facts.intent?.status === "queued")
    return { state: "waiting" };
  if (facts.runId !== undefined) return { state: "delivered", runId: RunId.parse(facts.runId) };
  // Written, but no run took it and its delivery failed (a Stop cancelled it, say): it will
  // never reach a run, so it isn't delivered.
  if (facts.intent?.status === "failed") return failedFate(facts.intent.error);
  if (facts.written) return { state: "delivered" };
  switch (facts.intent?.status) {
    case undefined:
      return { state: "unknown" };
    case "running":
      return { state: "sending" };
    case "done":
      return { state: "delivered" };
    case "failed":
      return failedFate(facts.intent.error);
  }
}

function failedFate(error: string | undefined): InputFate {
  return error === removedFromQueue
    ? { state: "removed" }
    : { state: "failed", error: error ?? "Not sent" };
}
