import { z } from "zod";
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

export function agentScope(owner: string): ScreenAgentScope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(owner);
  } catch {
    return undefined;
  }
  const parsed = z.tuple([z.string(), z.string()]).safeParse(value);
  if (!parsed.success) return undefined;
  const scope = ScreenAgentScope.safeParse({ threadId: parsed.data[0], agentId: parsed.data[1] });
  return scope.success ? scope.data : undefined;
}
