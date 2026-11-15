import type { MediaAcceleration } from "@ace/protocol";

/** Said when ace-media marks a source degraded without its own sentence. */
const fallback = "Video runs on the processor here.";

/**
 * The one sentence a live view adds to its status line while its source's video is degraded
 * (docs/media/plan.md, "Degraded, and the visible sentence"): ace-media's own reason, which names
 * what fell back to the processor and why. Empty when it isn't degraded, including a step that is
 * on the processor because the machine has no hardware for it, and before the source has chosen
 * its steps. Pure.
 */
export function degradedSentence(acceleration: MediaAcceleration | undefined): string {
  if (acceleration?.degraded !== true) return "";
  return acceleration.reason?.trim() || fallback;
}
