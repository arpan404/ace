import { retainToolRaw } from "./tool-raw.ts";
import type { Fact } from "@ace/core";
import { object, raw, string, type Data } from "./data.ts";
import { decodeResolution, interactionKey, interactionRequest } from "./interactions.ts";
import { TranslationState, type AgentState } from "./state.ts";
export function openRequest(
  s: TranslationState,
  id: string | number,
  method: string,
  params: Data,
  frame: unknown,
  facts: Fact[],
  updateTool: (owner: AgentState, update: Data) => void,
): boolean {
  if (s.requests.has(id)) {
    s.notice(facts, frame, method, "Duplicate pending ACP request");
    return true;
  }
  const request = interactionRequest(method, params, s.quirks.provider === "antigravity");
  const nativeTool = string(params["toolCallId"] ?? object(params["toolCall"])["toolCallId"]);
  let tool =
    typeof params["sessionId"] === "string"
      ? s.tool(s.agent(params["sessionId"], facts), nativeTool)
      : s.tools.get(nativeTool);
  const owner = tool?.owner ?? s.agent(string(params["sessionId"]), facts);
  if (!request) {
    if (method.startsWith("cursor/") && tool) {
      retainToolRaw(tool, raw(frame, method), {});
      facts.push({
        type: "item.upsert",
        agent: owner.key,
        item: tool.key,
        draft: { type: "tool_call", call: { raw: [...tool.raw] } },
      });
      return true;
    }
    return false;
  }
  if (!tool && nativeTool) {
    updateTool(owner, {
      ...object(params["toolCall"]),
      toolCallId: nativeTool,
      sessionUpdate: "tool_call",
      kind: "other",
      title: string(object(params["toolCall"])["title"]) || method,
      status: "pending",
    });
    tool = s.tool(owner, nativeTool);
  }
  const key = interactionKey(id);
  s.requests.set(id, { key, method, params, owner, request, ...(tool ? { tool } : {}) });
  if (tool) {
    tool.status = "awaiting_approval";
    s.liveTools.add(tool);
    facts.push({
      type: "item.upsert",
      agent: owner.key,
      item: tool.key,
      draft: { type: "tool_call", call: { status: "awaiting_approval" } },
    });
  }
  facts.push({
    type: "interaction.opened",
    agent: owner.key,
    interaction: key,
    blocking: true,
    request,
    ...(tool ? { item: tool.key } : {}),
    raw: [raw(frame, method)],
  });
  return true;
}
export function answerRequest(
  s: TranslationState,
  id: string | number,
  result: Data,
  frame: unknown,
  facts: Fact[],
): boolean {
  const pending = s.requests.get(id);
  if (!pending) return false;
  s.requests.delete(id);
  const resolution = decodeResolution(pending.method, pending.params, result, pending.request);
  facts.push({
    type: "interaction.closed",
    interaction: pending.key,
    state: object(result["outcome"])["outcome"] === "cancelled" ? "cancelled" : "resolved",
    ...(resolution ? { resolution } : {}),
  });
  if (pending.tool) {
    const tool = pending.tool;
    tool.declined =
      (resolution?.kind === "plan_review" && resolution.decision === "reject") ||
      (resolution?.kind === "approval" &&
        pending.request.kind === "approval" &&
        pending.request.options.some(
          (o) => o.id === resolution.optionId && ["deny", "deny_always"].includes(o.kind),
        ));
    tool.status = tool.declined ? "declined" : "running";
    if (tool.declined) s.liveTools.delete(tool);
    else s.liveTools.add(tool);
    retainToolRaw(tool, raw(frame, pending.method), {});
    facts.push({
      type: "item.upsert",
      agent: pending.owner.key,
      item: tool.key,
      draft: { type: "tool_call", call: { status: tool.status, raw: [...tool.raw] } },
    });
  }
  return true;
}
