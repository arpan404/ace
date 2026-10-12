import type { Command, CommandResult } from "@ace/protocol";

/** Only use before an external effect is admitted, never to reinterpret its failure. */
export function commandNotDispatched(command: Command, error: string): CommandResult {
  const payload = command.payload;
  return {
    commandId: command.id,
    ok: false,
    error,
    code: "action_not_dispatched",
    ...(payload.type === "forge.issue.write"
      ? {
          issueAction: {
            id: command.id,
            action: payload.input.action,
            state: "failed",
            error,
          } as const,
        }
      : {}),
  };
}
