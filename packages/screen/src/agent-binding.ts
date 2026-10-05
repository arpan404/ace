import { ScreenAgentScope } from "@ace/protocol";
/** Bind both IDs: separate threads may use the same agent id. */
export function agentOwner(input: ScreenAgentScope): string {
  const scope = ScreenAgentScope.parse(input);
  return JSON.stringify([scope.threadId, scope.agentId]);
}

export class ScreenDelegationError extends Error {
  readonly code = "delegation_required";
  readonly hint =
    "Ask the user to enable screen access, approve an app and delegate its screen session to this agent. After human takeover, wait for delegation again.";
  constructor() {
    super("Screen delegation required");
  }
}
