import type { ThreadStatus, CliTree } from "@ace/protocol";
export const exitCodes = {
  ok: 0,
  failed: 1,
  "needs-human": 2,
  timeout: 3,
  refused: 4,
  uncertain: 5,
} as const;
export type Outcome = keyof typeof exitCodes;
export function statusOutcome(status: ThreadStatus): Outcome | undefined {
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
export function treeOutcome(members: CliTree): Outcome | undefined {
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
export function formatOutput(value: unknown, json: boolean): string {
  if (!json && typeof value === "string") return `${value}\n`;
  return `${JSON.stringify(value, null, json ? undefined : 2)}\n`;
}
export class CliFailure extends Error {
  readonly outcome: Outcome;
  readonly evidence: unknown;
  constructor(outcome: Outcome, message: string, evidence?: unknown) {
    super(message);
    this.outcome = outcome;
    this.evidence = evidence;
  }
}
