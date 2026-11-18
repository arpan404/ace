import { aceToolAction } from "@ace/mcp-server";
import type { Fact, ThreadState } from "@ace/core";

/**
 * The ace tool call an approval belongs to: the agent's one in-flight call to ace's own MCP
 * server, preferring the named tool when several are in flight. Its outcome then reads on that
 * call's row instead of as a row of its own.
 */
export function liveAceCall(
  state: ThreadState,
  agentKey: string,
  tool?: string,
): string | undefined {
  const agentId = state.agents[agentKey]?.agent.id;
  const calls: { key: string; tool: string }[] = [];
  for (const key of Object.keys(state.indexes.liveTools)) {
    const item = state.items[key];
    if (item?.type !== "tool_call" || item.agentId !== agentId) continue;
    const detail = item.call.detail;
    if (detail.kind === "mcp" && detail.server === "ace") calls.push({ key, tool: detail.tool });
  }
  if (calls.length === 1) return calls[0]?.key;
  const named = calls.filter((call) => call.tool === tool);
  return named.length === 1 ? named[0]?.key : undefined;
}

/**
 * The agent making a live call to ace's `tool` whose arguments `matches`: its key when exactly
 * one agent is, so a request the call opens (browser help, say) belongs to the subagent that asked
 * and shows in its lane. Only agents on this machine count. Undefined when none is, or several
 * are and the caller can't be told, so the request falls back to the root.
 */
export function aceCaller(
  state: ThreadState,
  tool: string,
  matches: (args: unknown) => boolean,
): string | undefined {
  const callers = new Set<string>();
  for (const key of Object.keys(state.indexes.liveTools)) {
    const item = state.items[key];
    if (item?.type !== "tool_call") continue;
    const detail = item.call.detail;
    if (detail.kind !== "mcp" || detail.server !== "ace" || detail.tool !== tool) continue;
    if (!matches(detail.arguments)) continue;
    const agent = state.indexes.agentKeysById[item.agentId];
    // Only this machine's agents can have made the call: tab ids repeat across machines, and a
    // child elsewhere asks through its own machine.
    if (agent === undefined || state.agents[agent]?.agent.machine !== undefined) continue;
    callers.add(agent);
  }
  return callers.size === 1 ? [...callers][0] : undefined;
}

/** Only daemon catalog entries with validated arguments earn ace action metadata. */
export function attributeAceAction(
  state: ThreadState,
  fact: Fact,
  resolve: typeof aceToolAction = aceToolAction,
): Fact {
  if (fact.type === "item.upsert" && fact.draft.type === "tool_call") {
    const detail = fact.draft.call?.detail;
    const action =
      detail?.kind === "mcp" && detail.server === "ace" && detail.tool
        ? resolve(detail.tool, detail.arguments)
        : undefined;
    if (action)
      return {
        ...fact,
        draft: {
          ...fact.draft,
          call: { ...fact.draft.call, title: action.description ?? action.tool },
        },
      };
    return fact;
  }
  if (fact.type !== "interaction.opened" || fact.request.kind !== "approval") return fact;
  // A provider's own gate on an ace tool call (Codex asks before the call) joins that call.
  if (fact.item === undefined && fact.request.mcpServer?.name === "ace") {
    const call = liveAceCall(state, fact.agent, fact.request.target?.tool);
    if (call) return attributeAceAction(state, { ...fact, item: call }, resolve);
  }
  const request = fact.request;
  const target = request.target;
  const item = fact.item ? state.items[fact.item] : undefined;
  const detail = item?.type === "tool_call" ? item.call.detail : undefined;
  const action =
    target?.tool.startsWith("mcp__ace__") || request.mcpServer?.name === "ace"
      ? resolve(target?.tool ?? "", target?.input)
      : detail?.kind === "mcp" && detail.server === "ace"
        ? resolve(detail.tool, detail.arguments)
        : undefined;
  if (action)
    return {
      ...fact,
      request: {
        ...request,
        target: action,
        title: action.description ?? action.tool,
        description: action.description,
      },
    };
  // Provider-owned fields cannot impersonate daemon risk attribution.
  if (target) {
    const { origin: _origin, riskClass: _risk, description: _description, ...native } = target;
    return { ...fact, request: { ...request, target: native } };
  }
  return fact;
}
