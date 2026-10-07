import type { AgentError, Fact, Key, ToolCallDraft } from "@ace/core";
import type { ProviderKind, RunTrigger, ToolStatus } from "@ace/protocol";

/** Small builders for adapter facts, so scripts read like transcripts. */
export function rootAgent(provider: ProviderKind, cwd = "/Users/dev/acme"): Fact {
  return {
    type: "agent.seen",
    agent: "root",
    origin: "root",
    fidelity: "full",
    native: { provider, nativeId: "root" },
    cwd,
  };
}
export function subagent(
  provider: ProviderKind,
  agent: Key,
  name: string,
  spawnedBy: Key,
  options: { parent?: Key; background?: boolean } = {},
): Fact {
  return {
    type: "agent.seen",
    agent,
    parent: options.parent ?? "root",
    spawnedBy,
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider, nativeId: agent },
    cwd: "/Users/dev/acme",
    name,
    background: options.background ?? false,
  };
}
export function turn(agent: Key, trigger: RunTrigger = "user"): Fact {
  return { type: "turn.started", agent, nativeTurnId: `${agent}-turn`, trigger };
}
export function endTurn(
  agent: Key,
  outcome: "completed" | "interrupted" | "failed" = "completed",
  error?: AgentError,
): Fact {
  return {
    type: "turn.ended",
    agent,
    nativeTurnId: `${agent}-turn`,
    outcome,
    ...(error ? { error } : {}),
  };
}
export function message(
  agent: Key,
  item: Key,
  role: "user" | "assistant",
  text: string,
  complete = true,
): Fact {
  return {
    type: "item.upsert",
    agent,
    item,
    draft: { type: "message", role, complete, parts: [{ type: "text", text }] },
  };
}
export function stream(agent: Key, item: Key, append: string): Fact {
  return { type: "item.delta", agent, item, field: "text", append };
}
export function finish(agent: Key, item: Key): Fact {
  return { type: "item.upsert", agent, item, draft: { type: "message", complete: true } };
}
export function tool(
  agent: Key,
  item: Key,
  call: Required<Pick<ToolCallDraft, "kind" | "title" | "detail">> & { status?: ToolStatus },
): Fact {
  return {
    type: "item.upsert",
    agent,
    item,
    draft: {
      type: "tool_call",
      complete: false,
      call: { status: "running", raw: [], ...call },
    },
  };
}
export function toolDone(agent: Key, item: Key, status: ToolStatus = "succeeded"): Fact {
  return {
    type: "item.upsert",
    agent,
    item,
    draft: { type: "tool_call", complete: true, call: { status } },
  };
}
export function output(agent: Key, item: Key, append: string): Fact {
  return { type: "item.delta", agent, item, field: "output", append };
}
