import { aceToolAction } from "@ace/mcp-server";
import type { Fact, ThreadState } from "@ace/core";

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
