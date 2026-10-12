import type { Item, Thread, ThreadListEntry, Interaction } from "@ace/protocol";
import { threadAttention } from "@ace/projection";
import type { ThreadReader } from "@ace/client";

export function threadRow(thread: Thread | ThreadListEntry) {
  return {
    id: thread.id,
    title: thread.title,
    state: thread.status.state,
    attention: threadAttention(thread) ?? null,
    project: thread.details?.workspace?.name ?? thread.workspaceId,
    branch: thread.details?.branch ?? "",
    machine: thread.details?.machine?.name ?? "",
    provider: thread.provider,
    model: thread.live?.model ?? thread.execution?.model ?? "",
    agents: (thread.live?.subagentCount ?? 0) + 1,
    snoozedUntil: thread.snoozedUntil ?? null,
    updatedAt: thread.updatedAt,
    canSteer: thread.capabilities?.steer ?? false,
  };
}
export function itemRow(item: Item, index?: number) {
  let text = "";
  let role = "";
  if (item.type === "message") {
    text = item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    role = item.role;
  } else if (item.type === "tool_call") text = item.call.title;
  else if (item.type === "reasoning" || item.type === "notice") text = item.text;
  else if (item.type === "delegation.started") text = item.title;
  else text = item.type;
  return {
    id: item.id,
    index: index ?? null,
    type: item.type,
    role,
    text: text.slice(-8192),
    complete: item.complete,
    createdAt: item.createdAt,
    agentId: "agentId" in item ? item.agentId : "",
    truncated: text.length > 8192,
  };
}
export function approvalRow(interaction: Interaction, reader: ThreadReader) {
  const request = interaction.request;
  const item = interaction.toolCallId ? reader.item(interaction.toolCallId) : undefined;
  const command =
    item?.type === "tool_call" && item.call.detail.kind === "shell" ? item.call.detail.command : "";
  return {
    id: interaction.id,
    kind: request.kind,
    state: interaction.state,
    title: request.kind === "approval" ? request.title : "Your answer is needed",
    description: request.kind === "approval" ? (request.description ?? "") : "",
    command,
    options: request.kind === "approval" ? request.options : [],
  };
}
