import type { Item, Thread, ThreadListEntry, Interaction } from "@ace/protocol";
import { threadAttention } from "@ace/projection";
import { mobileThreadStatus, transcriptRowContent } from "@ace/ui-core/mobile";
import type { ThreadReader } from "@ace/client";
import {
  cardDetails,
  inputLine,
  parseDelegationResults,
  projectBadge,
  settledResults,
  settledSummary,
  systemInput,
} from "@ace/ui-core";
import { host } from "./host.ts";

/** Native Unicode segmentation also replaces ill-formed display text before JSON encoding. */
export function preview(text: string, limit = 512): string {
  return host.previewHead(text, limit);
}

/**
 * A settled delegation as one compact line: the shared finished count, never the raw
 * event label and never the full repeated results inline. Per-child leads stay one
 * tap away on each child's thread, through the existing subagent navigation.
 */
export function settledText(item: Item): string | undefined {
  const results = settledResults(item);
  return results?.length ? settledSummary(results) : undefined;
}

/** The same summary when the results arrive as the agent's input message. */
export function settledMessageText(text: string): string | undefined {
  return settledSummary(parseDelegationResults(text));
}

/** A message carrying settled results, rather than the person's words. */
function settledInput(item: Item) {
  if (item.type !== "message") return undefined;
  const input = systemInput(item);
  return input?.kind === "subagent_result" ? input : undefined;
}

// Handoffs keep their divider; any other ace input with a line reads as a quiet notice.
function quietLine(item: Item) {
  if (item.type !== "message") return undefined;
  const input = systemInput(item);
  if (!input || input.kind === "subagent_result" || input.kind === "handoff") return undefined;
  return inputLine(input);
}

export function threadRow(thread: Thread | ThreadListEntry) {
  const card = cardDetails(thread, undefined);
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    badge: projectBadge({
      id: thread.workspaceId,
      name: thread.details?.workspace?.name ?? thread.workspaceId,
    }).initials,
    diff: thread.details?.diff ?? null,
    testsRunning: thread.status.state === "working" && thread.live?.step === "tests",
    title: preview(thread.title),
    state: thread.status.state,
    status: mobileThreadStatus(thread),
    attention: threadAttention(thread) ?? null,
    project: preview(thread.details?.workspace?.name ?? thread.workspaceId),
    branch: preview(thread.details?.branch ?? ""),
    machine: preview(thread.details?.machine?.name ?? ""),
    provider: thread.provider,
    model: preview(thread.live?.model ?? thread.execution?.model ?? ""),
    agents: (thread.live?.subagentCount ?? 0) + 1,
    snoozedUntil: thread.snoozedUntil ?? null,
    archivedAt: thread.archivedAt ?? null,
    updatedAt: thread.updatedAt,
    canSteer: thread.capabilities?.steer ?? false,
    /** The pull request the thread's card names ("#1188"), with its state, for the inbox. */
    pr: card.pr === undefined ? null : { number: card.pr, state: card.prState ?? "open" },
    /** Start of the current working stretch while the tree works, for the row's age. */
    workingSince: thread.status.state === "working" ? (thread.live?.workingSince ?? null) : null,
  };
}
export function itemRow(item: Item, index?: number, sourceTruncated = false) {
  // Shared row content; iOS expands steps in place, so they carry their full text.
  const content = transcriptRowContent(item);
  let text = content.text;
  // A settled delegation is ace's input on either delivery path, never the person's bubble.
  const input = settledInput(item);
  const line = quietLine(item);
  const role = item.type === "message" && !input && !line ? item.role : "";
  if (item.type === "tool_call") text = item.call.title;
  else if (item.type === "reasoning") text = item.text;
  else if (item.type === "delegation.started") text = item.title;
  else if (item.type === "delegation.settled")
    text = settledText(item) ?? "Delegated work finished";
  else if (input)
    text =
      sourceTruncated || !item.complete
        ? "Delegated results available"
        : (settledMessageText(input.text) ?? "Delegated results available");
  else if (line) text = line.text;
  else if (item.type === "compaction") text = "Context compacted";
  else if (
    item.type !== "message" &&
    item.type !== "html" &&
    item.type !== "image" &&
    item.type !== "notice"
  )
    text = item.type;
  return {
    /** The shared secondary line, such as the visualization fallback. */
    detail: preview(content.detail, 512),
    quiet: content.quiet,
    id: item.id,
    index: index ?? null,
    type: input ? "delegation.settled" : line ? "notice" : item.type,
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
