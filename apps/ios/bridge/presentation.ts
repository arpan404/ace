import type { Item, Thread, ThreadListEntry, Interaction } from "@ace/protocol";
import { threadAttention } from "@ace/projection";
import type { ThreadReader } from "@ace/client";
import { host } from "./host.ts";

/** Native Unicode segmentation also replaces ill-formed display text before JSON encoding. */
export function preview(text: string, limit = 512): string {
  return host.previewHead(text, limit);
}

export function threadRow(thread: Thread | ThreadListEntry) {
  return {
    id: thread.id,
    title: preview(thread.title),
    state: thread.status.state,
    attention: threadAttention(thread) ?? null,
    project: preview(thread.details?.workspace?.name ?? thread.workspaceId),
    branch: preview(thread.details?.branch ?? ""),
    machine: preview(thread.details?.machine?.name ?? ""),
    provider: thread.provider,
    model: preview(thread.live?.model ?? thread.execution?.model ?? ""),
    agents: (thread.live?.subagentCount ?? 0) + 1,
    snoozedUntil: thread.snoozedUntil ?? null,
    updatedAt: thread.updatedAt,
    canSteer: thread.capabilities?.steer ?? false,
  };
}
export function itemRow(item: Item, index?: number, sourceTruncated = false) {
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
    text: host.previewTail(text, 8192),
    complete: item.complete,
    createdAt: item.createdAt,
    agentId: "agentId" in item ? item.agentId : "",
    truncated: sourceTruncated || text.length > 8192,
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
    title: request.kind === "approval" ? preview(request.title) : "Your answer is needed",
    description: request.kind === "approval" ? preview(request.description ?? "", 2048) : "",
    command: preview(command, 8192),
    truncated:
      command.length > 8192 ||
      (request.kind === "approval" &&
        (request.title.length > 512 || (request.description?.length ?? 0) > 2048)),
    options:
      request.kind === "approval"
        ? request.options.map((option) => ({
            id: option.id,
            kind: option.kind,
            label: preview(option.label, 128),
          }))
        : [],
  };
}
