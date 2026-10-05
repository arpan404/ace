import { PublicToolError } from "@ace/mcp-server";
import { ScreenAgentScope } from "@ace/protocol";
/** Bind both IDs: separate threads may use the same agent id. */
export function agentOwner(input: ScreenAgentScope): string {
  const scope = ScreenAgentScope.parse(input);
  return JSON.stringify([scope.threadId, scope.agentId]);
}

export class ScreenDelegationError extends PublicToolError {
  constructor() {
    super("delegation_required");
  }
}
