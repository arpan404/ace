import { retainToolRaw } from "./tool-raw.ts";
import { finalizeTool } from "./tool-final.ts";
import { retireTool } from "./completed-tools.ts";
import { answerIsNeutral, answerRefusesTool } from "./settlement.ts";
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
    s.notice(facts, frame, method);
    return true;
  }
  const request = interactionRequest(method, params, s.quirks);
  const nativeTool = string(params["toolCallId"] ?? object(params["toolCall"])["toolCallId"]);
  let tool =
    typeof params["sessionId"] === "string"
      ? s.tool(s.agent(params["sessionId"], facts), nativeTool)
      : s.tools.get(nativeTool);
  const owner = tool?.owner ?? s.agent(string(params["sessionId"]), facts);
  if (!request) {
    if (method.startsWith("cursor/") && tool) {
      retainToolRaw(tool, raw(frame, method), {});
      if (tool.finalized && !["pending", "running", "awaiting_approval"].includes(tool.status)) {
        s.notice(facts, frame, method, undefined, owner);
        return true;
      }
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
  const call = object(params["toolCall"]);
  if (tool && nativeTool && Object.keys(call).some((key) => key !== "toolCallId")) {
    // The request's own call is what approving runs: it replaces what an earlier update said.
    updateTool(owner, { ...call, toolCallId: nativeTool, sessionUpdate: "tool_call_update" });
  }
  const synthesized = requestTool(method, params);
  if (!tool && synthesized) {
    updateTool(owner, synthesized);
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
/**
 * The tool a request names, as a tool_call update: an approval-first tool has no notification
 * before its request. Translation and the session's shell settlement both read it from here.
 */
export function requestTool(
  method: string,
  params: Data,
): (Data & { toolCallId: string }) | undefined {
  const call = object(params["toolCall"]);
  const toolCallId = string(params["toolCallId"] ?? call["toolCallId"]);
  if (!toolCallId) return undefined;
  return {
    ...call,
    toolCallId,
    sessionUpdate: "tool_call",
    kind: string(call["kind"]) || "other",
    title: string(call["title"]) || method,
    status: string(call["status"]) || "pending",
  };
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
  const cancelled = object(result["outcome"])["outcome"] === "cancelled";
  facts.push({
    type: "interaction.closed",
    interaction: pending.key,
    state: cancelled ? "cancelled" : "resolved",
    ...(resolution ? { resolution } : {}),
  });
  if (pending.tool) {
    const tool = pending.tool;
    tool.declined = answerRefusesTool(pending.request, resolution, false);
    // A cancelled request never let the tool start: it settles like a decline, as cancelled.
    // A neutral choice ("Ask later") neither starts nor refuses it: the agent's updates settle it.
    tool.status = tool.declined
      ? "declined"
      : cancelled
        ? "cancelled"
        : answerIsNeutral(pending.request, resolution)
          ? "pending"
          : "running";
    const settled = tool.status !== "running";
    if (settled) s.liveTools.delete(tool);
    else s.liveTools.add(tool);
    retainToolRaw(tool, raw(frame, pending.method), {});
    const detail = settled ? finalizeTool(tool, s.quirks) : undefined;
    facts.push({
      type: "item.upsert",
      agent: pending.owner.key,
      item: tool.key,
      draft: {
        type: "tool_call",
        complete: settled,
        call: { status: tool.status, ...(detail ? { detail } : {}), raw: [...tool.raw] },
      },
    });
    retireTool(s, tool);
  }
  return true;
}
