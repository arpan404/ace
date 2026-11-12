import type { CommandId, CommandPayload, CommandResult, ThreadDetails } from "@ace/protocol";

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
  commandId: CommandId,
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

/**
 * The refusal for a command that would run an agent on a host thread (ADR 0121): the daemon holds
 * it for Spade, whose tools act as it, and no provider ever runs it. A bot's hidden session
 * (`spade-bot`, ADR 0133) runs, but only the turns Spade asks for: `personRefusal` keeps every
 * client off it, and the daemon's brain service sends to it in-process.
 */
export function hostRefusal(
  commandId: CommandId,
  payload: CommandPayload,
  host: ThreadDetailsHost,
): CommandResult | undefined {
  if (host === "spade-bot" && widensAccess.has(payload.type)) return botRefusal(commandId);
  if (host !== "spade" || (!startsAgent.has(payload.type) && payload.type !== "thread.fork"))
    return undefined;
  return {
    commandId,
    ok: false,
    error: "host_thread",
    title: "Spade's own thread",
    detail: "Spade works through this thread; nothing runs in it.",
  };
}

type ThreadDetailsHost = import("@ace/protocol").Thread["host"];

/**
 * Commands that would change what a bot's session may do. Its access is read-only for good
 * (ADR 0133): no caller, the session's own agent included, may change it.
 */
const widensAccess = new Set<CommandPayload["type"]>(["thread.permission.set", "thread.mode.set"]);

function botRefusal(commandId: CommandId): CommandResult {
  return {
    commandId,
    ok: false,
    error: "host_thread",
    title: "A Spade bot's own thread",
    detail: "Spade runs this bot's turns here; talk to the bot in Spade.",
  };
}

/**
 * The refusal for a client's command on a host thread: one that would run an agent on Spade's
 * host thread, and every command on a bot's session, which Spade alone drives.
 */
export function personRefusal(
  commandId: CommandId,
  payload: CommandPayload,
  host: ThreadDetailsHost,
): CommandResult | undefined {
  if (host === "spade-bot") return botRefusal(commandId);
  return hostRefusal(commandId, payload, host);
}
