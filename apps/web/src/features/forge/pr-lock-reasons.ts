import type { ForgeLockReason } from "@ace/protocol";

/** GitHub's lock reasons, as the page says them. */
export const lockReasonLabels: Record<ForgeLockReason, string> = {
  off_topic: "Off-topic",
  too_heated: "Too heated",
  resolved: "Resolved",
  spam: "Spam",
};
