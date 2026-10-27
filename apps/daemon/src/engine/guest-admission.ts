import type { CommandPayload, CommandResult, ThreadDetails } from "@ace/protocol";

/**
 * Commands that would start or carry on an agent turn. A guest session (ADR 0105) holds remote
 * tool use from another machine and has no agent here, so none of these may run on one.
 */
const startsAgent = new Set<CommandPayload["type"]>([
  "thread.send",
  "thread.resume",
  "thread.limit",
  "thread.switch",
  "thread.merge",
  "thread.goal.set",
  "queue.resume",
  "queue.resend",
]);

/** The refusal for a command on a guest thread, or undefined when it may go on. */
export function guestRefusal(
  commandId: string,
  payload: CommandPayload,
  details: ThreadDetails | undefined,
): CommandResult | undefined {
  const guest = details?.guest;
  if (!guest || !startsAgent.has(payload.type)) return undefined;
  return {
    commandId,
    ok: false,
    error: "guest_thread",
    title: "No agent here",
    detail: `This thread holds work from ${guest.name || "another machine"}; it has no agent here.`,
  };
}
