import type { FollowUpBehavior } from "@ace/protocol";
/** Cmd/Ctrl+Enter sends this override; plain Enter leaves delivery unset for daemon defaults. */
export function oppositeFollowUpBehavior(behavior: FollowUpBehavior): FollowUpBehavior {
  return behavior === "queue" ? "steer" : "queue";
}
