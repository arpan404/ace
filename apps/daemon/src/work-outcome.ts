import type { ThreadStatus, CliTree } from "@ace/protocol";
export type WorkOutcome = "ok" | "failed" | "needs-human" | "uncertain";
export function statusOutcome(status: ThreadStatus): WorkOutcome | undefined {
  switch (status.state) {
    case "done":
      return "ok";
    case "failed":
      return "failed";
    case "needs_you":
      return "needs-human";
    case "unresponsive":
      return "uncertain";
    default:
      return undefined;
  }
}
export function treeOutcome(members: CliTree): WorkOutcome | undefined {
  if (
    !members.length ||
    members.some(
      (member) =>
        member.status.state === "unresponsive" ||
        member.queue.uncertain ||
        member.queue.reason === "uncertain",
    )
  )
    return "uncertain";
  if (
    members.some(
      (member) => member.status.state === "needs_you" || (member.attention && !member.cancelled),
    )
  )
    return "needs-human";
  if (
    members.some(
      (member) =>
        member.pending ||
        (member.queue.pendingCount ?? 0) > 0 ||
        statusOutcome(member.status) === undefined,
    )
  )
    return undefined;
  return members.some((member) => member.status.state === "failed" || member.cancelled)
    ? "failed"
    : "ok";
}
