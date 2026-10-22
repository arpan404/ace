import type { Item } from "@ace/protocol";
import type { DiffStat } from "./file-changes.ts";
import type { StepText } from "./work-log.ts";

/*
 * How a described step reads on its row, on every client: a stat counted off the main thread
 * replaces the described one; a command's exit code is no note of its own (a failed command
 * reads "Failed", a finished one nothing); and a step that waits on the person shows no words of
 * its own, since its request is the composer's. Pure.
 */

export interface ShownStep {
  step: StepText;
  /** The step waits on an approval nobody has answered yet. */
  awaiting: boolean;
}

export function shownStep(item: Item, described: StepText, counted?: DiffStat): ShownStep {
  // Without its interaction loaded, the provider's own status says whether it waits.
  const awaiting =
    described.needsYou ?? (item.type === "tool_call" && item.call.status === "awaiting_approval");
  const withStat = counted ? { ...described, ...counted } : described;
  const step = withStat.note?.startsWith("exit ")
    ? { ...withStat, note: withStat.failed ? "Failed" : undefined }
    : withStat;
  return {
    step: awaiting ? { ...step, verb: "", target: undefined, note: undefined } : step,
    awaiting,
  };
}

/** Whether a step's row opens to more: its output, diff, reasoning or failure. */
export function stepOpens(item: Item): boolean {
  if (item.type !== "tool_call") return item.type === "reasoning" || item.type === "notice";
  const detail = item.call.detail;
  if (item.call.error) return true;
  if (detail.kind === "shell") return !!detail.output;
  if (detail.kind === "search") return false;
  if (detail.kind === "web.search" || detail.kind === "web.fetch" || detail.kind === "file.read")
    return false;
  return true;
}
