/**
 * What a person sends a subagent's parent to have it run the subagent again, when the subagent
 * itself can't be messaged: which subagent, the task it had and how it ended, in one short
 * message the parent can act on. Pure.
 */
export function retryRequest(child: {
  /** The subagent's name as the person sees it. */
  name: string;
  /** The task it was given, when known. */
  task?: string | undefined;
  /** How it ended: failed with this reason, or stopped. */
  ended: { kind: "failed"; reason?: string | undefined } | { kind: "stopped" };
}): string {
  const task = child.task?.trim().split("\n")[0]?.trim();
  const who = `The subagent “${child.name}”${task && task !== child.name ? ` (${task})` : ""}`;
  const reason = child.ended.kind === "failed" ? child.ended.reason?.trim() : undefined;
  const how =
    child.ended.kind === "stopped"
      ? "was stopped before it finished."
      : reason
        ? `failed: ${reason.split("\n")[0]}`
        : "failed before it finished.";
  return `${who} ${how}\n\nPlease relaunch it to finish its task, picking up from what it already did.`;
}
